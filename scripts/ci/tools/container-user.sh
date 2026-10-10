# Opções --user para `docker run` nos jobs (carregado com `source`). Em Docker/Podman ROOTLESS o usuário do host é o root do
# contêiner (uid 0 do namespace); um uid comum viraria um subuid sem permissão de gravar no diretório montado. Em Docker
# comum (runner hospedado) vale o usuário do job, como antes.
container_user_args() {
  local rootless
  rootless="$(docker info --format '{{.Host.Security.Rootless}}' 2>/dev/null || true)"
  case "$rootless" in true) echo "--user 0:0"; return 0 ;; esac
  case "$(docker info --format '{{.SecurityOptions}}' 2>/dev/null || true)" in
    *rootless*) echo "--user 0:0" ;;
    *) echo "--user $(id -u):$(id -g)" ;;
  esac
}
