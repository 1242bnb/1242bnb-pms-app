# Crea los dos repos PRIVADOS en GitHub y sube cada uno con su historial completo.
# Correr en la terminal que YA hizo `gh auth login` (la de Administrador).
# Idempotente: si un repo ya existe, solo agrega el remoto y hace push.

$ErrorActionPreference = 'Stop'
$USER = (gh api user --jq '.login')
Write-Host "Autenticado como: $USER" -ForegroundColor Cyan

$repos = @(
  @{ path = 'C:\Users\sukov\Documents\1242bnb-pms-app'; name = '1242bnb-pms-app'; desc = 'PWA del PMS 1242BNB (Cloudflare Pages)' },
  @{ path = 'C:\Users\sukov\Documents\1242bnb-push';    name = '1242bnb-push';    desc = 'Worker de notificaciones push del PMS 1242BNB' }
)

foreach ($r in $repos) {
  Write-Host "`n=== $($r.name) ===" -ForegroundColor Yellow
  Set-Location $r.path

  # 1. Crear el repo PRIVADO (si ya existe, gh avisa y seguimos)
  $existe = gh repo view "$USER/$($r.name)" --json name 2>$null
  if ($existe) {
    Write-Host "  el repo ya existe en GitHub, no se recrea"
  } else {
    gh repo create "$r.name" --private --description "$($r.desc)" --disable-wiki
    Write-Host "  repo PRIVADO creado"
  }

  # 2. Remoto 'origin' apuntando al repo (lo reescribe si ya estaba)
  git remote remove origin 2>$null
  git remote add origin "https://github.com/$USER/$($r.name).git"

  # 3. Subir la rama actual + todas las etiquetas
  $rama = git rev-parse --abbrev-ref HEAD
  git push -u origin $rama
  git push origin --tags 2>$null

  Write-Host "  subido: rama '$rama'" -ForegroundColor Green
}

Write-Host "`n=== VERIFICACION ===" -ForegroundColor Cyan
foreach ($r in $repos) {
  $info = gh repo view "$USER/$($r.name)" --json name,visibility,defaultBranchRef,pushedAt | ConvertFrom-Json
  $commits = git -C $r.path rev-list --count HEAD
  "{0,-18} {1,-8} rama={2} commits_local={3}" -f $info.name, $info.visibility, $info.defaultBranchRef.name, $commits
}
Write-Host "`nListo. Los dos repos son PRIVADOS." -ForegroundColor Green
