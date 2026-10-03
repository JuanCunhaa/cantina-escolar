# Série intercalada da reprodução mínima: alterna condições em ciclos para que todas atravessem o mesmo período de rede/serviço.
# Uso (na raiz): powershell -File tools/listener-repro/interleave.ps1 -Cycles 2 -Tag A
param([int]$Cycles = 2, [string]$Tag = "A", [string]$Set = "navegadores")
$conditions = if ($Set -eq "ip") { @(
  @{ name = "chromium-padrao"; args = @("--browser", "chromium") },
  @{ name = "chromium-ipv4"; args = @("--browser", "chromium", "--pin", "ipv4") },
  @{ name = "firefox-padrao"; args = @("--browser", "firefox") },
  @{ name = "firefox-ipv4"; args = @("--browser", "firefox", "--pin", "ipv4") }
) } else { @(
  @{ name = "chromium-padrao"; args = @("--browser", "chromium") },
  @{ name = "chromium-rajada"; args = @("--browser", "chromium", "--churn", "--burst", "20") },
  @{ name = "firefox-padrao"; args = @("--browser", "firefox") },
  @{ name = "firefox-rajada"; args = @("--browser", "firefox", "--churn", "--burst", "20") },
  @{ name = "msedge-padrao"; args = @("--browser", "msedge") }
) }
for ($c = 1; $c -le $Cycles; $c++) {
  foreach ($cond in $conditions) {
    $scenario = "INT-$Tag-c$c-$($cond.name)"
    $lines = node tools/listener-repro/run.ts --scenario $scenario --runs 2 --delay 2000 --listeners calendar,probe,page --measure calendar @($cond.args) 2>&1 | Select-String -Pattern "^#|servidores do canal"
    foreach ($l in $lines) { "$((Get-Date).ToString('HH:mm:ss')) $scenario $($l.Line)" }
  }
}
