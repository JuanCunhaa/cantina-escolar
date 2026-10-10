#!/usr/bin/env bash
# Agente Veracode SCA (srcclr) fixado por versão, com cadeia de integridade conferida:
# chave GPG do repositório (impressão digital fixada) -> assinatura do Release -> SHA-256 do Packages -> SHA-256 do .deb (fixado).
# Idempotente: se a versão fixada já está instalada (runner próprio: instalada uma vez pelo administrador, scripts/ci/runner/setup-vps.sh),
# não faz nada. A instalação exige root ou sudo; o usuário do job no runner próprio não tem nenhum dos dois.
# Uso: bash scripts/ci/tools/install-srcclr.sh
set -euo pipefail
SRCCLR_VERSION=3.8.121
SRCCLR_DEB_SHA256=602f27292a69c2c8b130795da0288626bb1b8ccfc1302dae9405f791d36eed6b
KEY_FINGERPRINT=2B93609DA5A49D7F2082246FDF7DD7A50B746DD4
REPO=https://download.sourceclear.com/ubuntu/stable
if dpkg -s srcclr 2>/dev/null | grep -q "^Version: ${SRCCLR_VERSION}"; then
  echo "srcclr ${SRCCLR_VERSION} já instalado"
  srcclr --version
  exit 0
fi
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if sudo -n true 2>/dev/null; then SUDO=sudo; else echo "srcclr ${SRCCLR_VERSION} ausente e sem root/sudo: peça ao administrador para rodar scripts/ci/runner/setup-vps.sh"; exit 1; fi
fi
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
$SUDO dpkg -i "$tmp/srcclr.deb" >/dev/null
srcclr --version
