"""Offline checks for configurable certificate domains and saved renewal settings."""
import datetime
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

spec = importlib.util.spec_from_file_location('bridge_tls', Path(__file__).resolve().parents[1] / 'tls.py')
tls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tls)


def certificate(domain):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, domain)])
    now = datetime.datetime.now(datetime.timezone.utc)
    return (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=1))
            .not_valid_after(now + datetime.timedelta(days=90))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(domain)]), critical=False)
            .sign(key, hashes.SHA256()).public_bytes(serialization.Encoding.PEM))


class CertificateTests(unittest.TestCase):
    def test_subdomain_and_apex_records(self):
        self.assertEqual(tls.certificate_names('Phone.Example.COM.', 'Example.COM.'),
                         ('phone.example.com', 'example.com', '_acme-challenge.phone'))
        self.assertEqual(tls.certificate_names('example.com', 'example.com'),
                         ('example.com', 'example.com', '_acme-challenge'))
        self.assertEqual(tls.certificate_names('phone.office.example.com', 'example.com')[2],
                         '_acme-challenge.phone.office')

    def test_invalid_names_and_zone_boundaries(self):
        for domain in ('badexample.com', 'example.com.evil.test', '*.example.com',
                       'https://example.com', 'phone..example.com', '-bad.example.com'):
            with self.subTest(domain=domain), self.assertRaises(tls.CertificateError):
                tls.certificate_names(domain, 'example.com')

    def test_dns_query_uses_the_requested_record_and_proxy(self):
        session = Mock()
        session.get.return_value.json.return_value = {'Answer': [{'data': '"fixture-value"'}]}
        with patch.object(tls.requests, 'Session', return_value=session):
            self.assertTrue(tls.dns_visible('fixture-value', 'http://127.0.0.1:7893', '_acme-challenge.phone.example.com'))
        self.assertEqual(session.get.call_args.kwargs['params']['name'], '_acme-challenge.phone.example.com')
        self.assertEqual(session.proxies['https'], 'http://127.0.0.1:7893')
        self.assertFalse(session.trust_env)

    def test_valid_certificate_for_same_domain_does_not_call_acme(self):
        with tempfile.TemporaryDirectory(prefix='codex-tls-test-') as folder:
            state = Path(folder)
            (state / 'fullchain.pem').write_bytes(certificate('phone.example.com'))
            args = SimpleNamespace(domain='phone.example.com', zone='example.com', force=False)
            with patch.object(tls, 'STATE', state), patch.object(tls, 'ACME') as acme:
                tls.issue(args)
                acme.assert_not_called()

    def test_certificate_for_another_domain_is_not_reused(self):
        with tempfile.TemporaryDirectory(prefix='codex-tls-test-') as folder:
            state = Path(folder)
            (state / 'fullchain.pem').write_bytes(certificate('old.example.com'))
            args = SimpleNamespace(domain='phone.example.com', zone='example.com', force=False, proxy='')
            with patch.object(tls, 'STATE', state), patch.object(tls, 'ACME', side_effect=tls.CertificateError('offline boundary')) as acme:
                with self.assertRaisesRegex(tls.CertificateError, 'offline boundary'):
                    tls.issue(args)
                acme.assert_called_once_with('')

    def test_issuance_saves_requested_domain_and_renewal_configuration(self):
        self.check_saved_configuration('')

    def test_renewal_preserves_a_custom_external_https_port(self):
        self.check_saved_configuration('https://phone.example.com:24443')

    def check_saved_configuration(self, public_origin):
        with tempfile.TemporaryDirectory(prefix='codex-tls-test-') as folder:
            state = Path(folder)
            (state / 'config.json').write_text(json.dumps({'tlsPort': 19443, 'publicOrigin': public_origin, 'password': {'fixture': True}}))
            chain = certificate('phone.example.com')
            response = lambda data=None, **kwargs: SimpleNamespace(json=lambda: data, **kwargs)
            acme = Mock()
            acme.directory = {'newOrder': 'new-order'}
            acme.post.side_effect = [
                response({'authorizations': ['authorization'], 'finalize': 'finalize'}, headers={'Location': 'order'}),
                response({'status': 'valid'}), response({}),
                response({'status': 'valid', 'certificate': 'certificate'}), response(content=chain),
            ]
            dns = Mock()
            args = SimpleNamespace(domain='phone.example.com', zone='example.com', force=True,
                                   proxy='http://127.0.0.1:7893', dns_config=str(state / 'ddns.yaml'))
            with patch.object(tls, 'STATE', state), patch.object(tls, 'ACME', return_value=acme), patch.object(tls, 'AliDNS', return_value=dns):
                tls.issue(args)
            config = json.loads((state / 'config.json').read_text())
            self.assertEqual(config['domain'], 'phone.example.com')
            self.assertEqual(config['dnsZone'], 'example.com')
            self.assertEqual(config['tlsProxy'], args.proxy)
            self.assertEqual(config['publicOrigin'], public_origin or 'https://phone.example.com:19443')
            self.assertEqual(config['password'], {'fixture': True})
            self.assertEqual(acme.post.call_args_list[0].args[1]['identifiers'][0]['value'], args.domain)
            dns.call.assert_not_called()  # Existing ACME authorization requires no DNS changes.

    def test_only_the_new_txt_record_is_removed_on_validation_failure(self):
        with tempfile.TemporaryDirectory(prefix='codex-tls-test-') as folder:
            state = Path(folder)
            response = lambda data, **kwargs: SimpleNamespace(json=lambda: data, **kwargs)
            acme = Mock()
            acme.directory = {'newOrder': 'new-order'}
            acme.jwk = {'kty': 'RSA', 'n': 'fixture', 'e': 'AQAB'}
            acme.post.side_effect = [
                response({'authorizations': ['authorization']}, headers={'Location': 'order'}),
                response({'status': 'pending', 'challenges': [{'type': 'dns-01', 'token': 'fixture', 'url': 'challenge'}]}),
                tls.CertificateError('fixture validation failure'),
            ]
            dns = Mock()
            dns.call.return_value = {'RecordId': 'created-fixture-record'}
            args = SimpleNamespace(domain='phone.example.com', zone='example.com', force=True, proxy='', dns_config='unused')
            with patch.object(tls, 'STATE', state), patch.object(tls, 'ACME', return_value=acme), patch.object(tls, 'AliDNS', return_value=dns), patch.object(tls, 'dns_visible', return_value=True):
                with self.assertRaisesRegex(tls.CertificateError, 'fixture validation failure'):
                    tls.issue(args)
            self.assertEqual(dns.call.call_args_list[0].kwargs['DomainName'], 'example.com')
            self.assertEqual(dns.call.call_args_list[0].kwargs['RR'], '_acme-challenge.phone')
            self.assertEqual(dns.call.call_args_list[-1].args, ('DeleteDomainRecord',))
            self.assertEqual(dns.call.call_args_list[-1].kwargs, {'RecordId': 'created-fixture-record'})


if __name__ == '__main__':
    unittest.main()
