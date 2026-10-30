# Inicia el lanzador de Traza en segundo plano desde la carpeta real del proyecto.
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'start-web.mjs'))
try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $nodeVersion = & $node --version
    if ([version]$nodeVersion.TrimStart('v') -lt [version]'22.13.0') { throw 'Se requiere Node.js 22.13 o posterior.' }
    Start-Process -FilePath $node -ArgumentList @(('"' + $launcher + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show('No se pudo iniciar Traza. Instala Node.js 22.13 o posterior y vuelve a abrir el lanzador.', 'Traza') | Out-Null
}
