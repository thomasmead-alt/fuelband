#!/bin/sh
# Generate a local CA + a server cert impersonating Nike's API hosts.
# Run once, then trust ca.crt in the macOS System keychain (see MITM-SETUP.md).
set -e
cd "$(dirname "$0")"

# 1. Local CA
openssl genrsa -out ca.key 2048
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
  -subj "/CN=Nike Mock CA/O=fuelband-revival" -out ca.crt

# 2. Server key + CSR
openssl genrsa -out server.key 2048
openssl req -new -key server.key -subj "/CN=secure-nikeplus.nike.com" -out server.csr

# 3. SANs covering every Nike host the app might hit
cat > san.ext <<'EOF'
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:secure-nikeplus.nike.com,DNS:nikeplus.nike.com,DNS:www.nikeplus.com,DNS:www.nike.com,DNS:api.nike.com,DNS:*.nike.com,DNS:*.nikeplus.com
EOF

# 4. Sign
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 3650 -sha256 -extfile san.ext

rm -f server.csr san.ext ca.srl
echo
echo "Generated: ca.crt (trust this in Keychain), server.key + server.crt (used by the mock server)."
