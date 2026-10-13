#!/usr/bin/env bash
# Agente Veracode SCA (srcclr) fixado por versão, com cadeia de integridade conferida:
# chave GPG do repositório (impressão digital fixada) -> assinatura do Release -> SHA-256 do Packages -> SHA-256 do .deb (fixado).
# Uso: bash scripts/ci/tools/install-srcclr.sh
set -euo pipefail
SRCCLR_VERSION=3.8.122
SRCCLR_DEB_SHA256=f247082f32390dd57c6f8d80d94d6c1102fa1cfb54432360581ecb128e98ab89
KEY_FINGERPRINT=2B93609DA5A49D7F2082246FDF7DD7A50B746DD4
REPO=https://download.sourceclear.com/ubuntu/stable
tmp="$(mktemp -d)"
export GNUPGHOME="$tmp/gnupg"
mkdir -m 700 "$GNUPGHOME"
curl --proto '=https' --tlsv1.2 -sSfL -o "$tmp/key.asc" "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x${KEY_FINGERPRINT}"
gpg --batch --quiet --import "$tmp/key.asc"
gpg --batch --with-colons --fingerprint | grep -q "^fpr:::::::::${KEY_FINGERPRINT}:" || { echo "impressão digital da chave diferente da fixada"; exit 1; }
gpg --batch --export "$KEY_FINGERPRINT" > "$tmp/key.gpg"
curl --proto '=https' --tlsv1.2 -sSfL -o "$tmp/Release" "$REPO/Release"
curl --proto '=https' --tlsv1.2 -sSfL -o "$tmp/Release.gpg" "$REPO/Release.gpg"
gpgv --keyring "$tmp/key.gpg" "$tmp/Release.gpg" "$tmp/Release"
curl --proto '=https' --tlsv1.2 -sSfL -o "$tmp/Packages" "$REPO/Packages"
expected_packages="$(awk '/^SHA256:/{f=1;next} f && $3=="Packages"{print $1; exit}' "$tmp/Release")"
echo "${expected_packages}  $tmp/Packages" | sha256sum -c -
grep -q "^SHA256: ${SRCCLR_DEB_SHA256}$" "$tmp/Packages" || { echo "SHA-256 fixado do srcclr ${SRCCLR_VERSION} não consta do índice assinado"; exit 1; }
curl --proto '=https' --tlsv1.2 -sSfL -o "$tmp/srcclr.deb" "$REPO/srcclr_${SRCCLR_VERSION}.deb"
echo "${SRCCLR_DEB_SHA256}  $tmp/srcclr.deb" | sha256sum -c -
sudo dpkg -i "$tmp/srcclr.deb" >/dev/null
srcclr --version
