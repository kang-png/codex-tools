"""Obtain/renew a certificate using ACME DNS-01 and the existing DDNS-Go AliDNS credentials.

Only the TXT record created by this invocation is removed. Credential values are
read in memory and are never copied into this project or printed.
"""
import argparse, base64, datetime, hashlib, hmac, json, pathlib, re, sys, time, urllib.parse, uuid
import requests, yaml
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import NameOID

ROOT = pathlib.Path(__file__).resolve().parent
STATE = ROOT / 'private'
DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory'

def b64(data): return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')
def compact(data): return json.dumps(data, sort_keys=True, separators=(',', ':')).encode()
def integer(value): return b64(value.to_bytes((value.bit_length()+7)//8, 'big'))

class CertificateError(Exception): pass

def certificate_names(domain, zone):
    domain, zone = domain.lower().rstrip('.'), zone.lower().rstrip('.')
    label = r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
    pattern = rf'{label}(?:\.{label})+'
    if any(len(name) > 253 or not re.fullmatch(pattern, name) for name in (domain, zone)):
        raise CertificateError('Use valid ASCII DNS names; encode international names as Punycode')
    if domain != zone and not domain.endswith('.' + zone):
        raise CertificateError('The certificate domain must belong to the supplied DNS zone')
    prefix = domain[:-(len(zone) + 1)] if domain != zone else ''
    return domain, zone, '_acme-challenge' + ('.' + prefix if prefix else '')

class AliDNS:
    def __init__(self, path):
        config = yaml.safe_load(pathlib.Path(path).read_text(encoding='utf-8-sig'))
        matches = [item['dns'] for item in config.get('dnsconf', []) if item.get('dns', {}).get('name') == 'alidns']
        if len(matches) != 1: raise CertificateError('Expected exactly one AliDNS account in DDNS-Go config')
        self.key, self.secret = matches[0]['id'], matches[0]['secret']
        self.session = requests.Session(); self.session.trust_env = False
    def call(self, action, **values):
        params = dict(Format='JSON', Version='2015-01-09', AccessKeyId=self.key, SignatureMethod='HMAC-SHA1',
            SignatureVersion='1.0', SignatureNonce=str(uuid.uuid4()), Timestamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), Action=action, **values)
        quote = lambda value: urllib.parse.quote(str(value), safe='~')
        canonical = '&'.join(quote(k)+'='+quote(v) for k,v in sorted(params.items()))
        string = 'POST&%2F&'+quote(canonical)
        params['Signature'] = base64.b64encode(hmac.new((self.secret+'&').encode(), string.encode(), hashlib.sha1).digest()).decode()
        try: response = self.session.post('https://alidns.aliyuncs.com/', data=params, timeout=20)
        except requests.RequestException: raise CertificateError('AliDNS connection failed') from None
        if not response.ok: raise CertificateError('AliDNS HTTP status '+str(response.status_code))
        result = response.json()
        if 'Code' in result: raise CertificateError('AliDNS API error: '+str(result['Code']))
        return result

class ACME:
    def __init__(self, proxy):
        self.session = requests.Session(); self.session.trust_env = False
        if proxy: self.session.proxies = {'http': proxy, 'https': proxy}
        self.directory = self.session.get(DIRECTORY, timeout=25).json()
        key_path = STATE / 'acme-account.key'
        if key_path.exists(): self.key = serialization.load_pem_private_key(key_path.read_bytes(), None)
        else:
            self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            key_path.write_bytes(self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        numbers = self.key.public_key().public_numbers()
        self.jwk = {'kty': 'RSA', 'n': integer(numbers.n), 'e': integer(numbers.e)}
        self.nonce = None; self.kid = None
        account_path = STATE / 'acme-account.json'
        if account_path.exists(): self.kid = json.loads(account_path.read_text())['url']
        else:
            response = self.post(self.directory['newAccount'], {'termsOfServiceAgreed': True})
            self.kid = response.headers['Location']; account_path.write_text(json.dumps({'url': self.kid}))
    def post(self, url, payload=None):
        for attempt in range(2):
            if not self.nonce: self.nonce = self.session.head(self.directory['newNonce'], timeout=20).headers['Replay-Nonce']
            protected = {'alg': 'RS256', 'nonce': self.nonce, 'url': url, **({'kid': self.kid} if self.kid else {'jwk': self.jwk})}
            signed_header = b64(compact(protected)); signed_payload = b64(compact(payload)) if payload is not None else ''
            signature = self.key.sign((signed_header+'.'+signed_payload).encode(), padding.PKCS1v15(), hashes.SHA256())
            response = self.session.post(url, json={'protected': signed_header, 'payload': signed_payload, 'signature': b64(signature)}, headers={'Content-Type': 'application/jose+json'}, timeout=30)
            self.nonce = response.headers.get('Replay-Nonce')
            if response.ok: return response
            try: code = response.json().get('type', 'unknown').split(':')[-1]
            except ValueError: code = 'HTTP '+str(response.status_code)
            if code == 'badNonce' and attempt == 0: continue
            raise CertificateError('ACME request failed: '+code)
        raise CertificateError('ACME nonce retry failed')

def dns_visible(value, proxy, record_name):
    try:
        session = requests.Session(); session.trust_env = False
        if proxy: session.proxies = {'http': proxy, 'https': proxy}
        response = session.get('https://dns.google/resolve', params={'name': record_name, 'type': 'TXT'}, timeout=15)
        return any(value in answer.get('data','') for answer in response.json().get('Answer', []))
    except (requests.RequestException, ValueError): return False

def issue(args):
    domain, zone, rr = certificate_names(args.domain, args.zone)
    STATE.mkdir(exist_ok=True)
    cert_path = STATE/'fullchain.pem'; key_path = STATE/'tls-key.pem'
    if cert_path.exists() and not args.force:
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        try: names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
        except x509.ExtensionNotFound: names = []
        if domain in names and cert.not_valid_after_utc > datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=30):
            print('Existing certificate is still valid; renewal is not due.', flush=True); return
    acme = ACME(args.proxy); dns = AliDNS(args.dns_config)
    response = acme.post(acme.directory['newOrder'], {'identifiers':[{'type':'dns','value':domain}]})
    order_url = response.headers['Location']; order = response.json(); record_id = None
    try:
        for auth_url in order['authorizations']:
            authorization = acme.post(auth_url).json()
            if authorization['status'] == 'valid': continue
            challenge = next(c for c in authorization['challenges'] if c['type']=='dns-01')
            key_auth = challenge['token']+'.'+b64(hashlib.sha256(compact(acme.jwk)).digest())
            value = b64(hashlib.sha256(key_auth.encode()).digest())
            record_id = dns.call('AddDomainRecord', DomainName=zone, RR=rr, Type='TXT', Value=value, TTL='600')['RecordId']
            print('Temporary DNS TXT record created. Waiting for propagation.', flush=True)
            for attempt in range(24):
                if dns_visible(value, args.proxy, rr + '.' + zone): break
                time.sleep(5)
            else: raise CertificateError('DNS propagation timed out')
            print('DNS propagated. Requesting domain validation.', flush=True)
            acme.post(challenge['url'], {})
            for attempt in range(30):
                authorization = acme.post(auth_url).json()
                if authorization['status']=='valid': break
                if authorization['status']=='invalid': raise CertificateError('ACME DNS validation failed')
                time.sleep(2)
            else: raise CertificateError('ACME validation timed out')
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        csr = x509.CertificateSigningRequestBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, domain)])).add_extension(x509.SubjectAlternativeName([x509.DNSName(domain)]), critical=False).sign(key, hashes.SHA256())
        acme.post(order['finalize'], {'csr': b64(csr.public_bytes(serialization.Encoding.DER))})
        for attempt in range(30):
            order = acme.post(order_url).json()
            if order['status']=='valid' and order.get('certificate'): break
            if order['status']=='invalid': raise CertificateError('ACME order failed')
            time.sleep(2)
        else: raise CertificateError('Certificate issuance timed out')
        chain = acme.post(order['certificate']).content
        cert = x509.load_pem_x509_certificate(chain)
        key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        cert_path.write_bytes(chain)
        config_path = STATE/'config.json'
        config = json.loads(config_path.read_text(encoding='utf-8'))
        public_origin = config.get('publicOrigin', '')
        existing_origin = urllib.parse.urlsplit(public_origin)
        if existing_origin.scheme != 'https' or existing_origin.hostname != domain:
            public_origin = f'https://{domain}:{config["tlsPort"]}'
        config.update(certificate=str(cert_path), privateKey=str(key_path), dnsConfigPath=str(pathlib.Path(args.dns_config).resolve()), pythonExecutable=sys.executable,
            domain=domain, dnsZone=zone, tlsProxy=args.proxy, publicOrigin=public_origin)
        config_path.write_text(json.dumps(config,ensure_ascii=False,indent=2), encoding='utf-8')
        print('Certificate issued for '+domain+'; expires '+cert.not_valid_after_utc.isoformat(), flush=True)
    finally:
        if record_id:
            dns.call('DeleteDomainRecord', RecordId=record_id)
            print('Temporary DNS challenge record removed.', flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--dns-config', required=True)
    parser.add_argument('--domain', required=True)
    parser.add_argument('--zone', required=True)
    parser.add_argument('--proxy', default='')
    parser.add_argument('--force', action='store_true')
    arguments=parser.parse_args()
    try: issue(arguments)
    except (CertificateError, requests.RequestException) as error:
        print('Certificate setup failed: '+(str(error) if isinstance(error,CertificateError) else type(error).__name__),file=sys.stderr);sys.exit(1)
