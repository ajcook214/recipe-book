<#
.SYNOPSIS
  Minimal static file server for local development.

.DESCRIPTION
  This project has no build step and no package dependencies, but it still
  needs an http:// origin: ES module imports, import maps and service workers
  are all blocked from file://. This serves the repo with nothing installed,
  using only what ships with Windows.

  Responses are sent with no-cache headers so a reload always picks up the
  edit you just made.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/serve.ps1
  powershell -ExecutionPolicy Bypass -File tools/serve.ps1 -Port 8080
#>
[CmdletBinding()]
param(
  [int]$Port = 8123,
  [string]$Root
)

$ErrorActionPreference = 'Stop'

# Resolved here rather than as a param default: under Windows PowerShell 5.1
# $PSScriptRoot is not yet populated while param defaults are evaluated.
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path $Root).Path

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.map'  = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'
  '.gif'  = 'image/gif'
  '.ico'  = 'image/x-icon'
  '.woff' = 'font/woff'
  '.woff2' = 'font/woff2'
  '.txt'  = 'text/plain; charset=utf-8'
  '.md'   = 'text/plain; charset=utf-8'
  '.webmanifest' = 'application/manifest+json'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")

try {
  $listener.Start()
} catch {
  Write-Error "Could not bind http://localhost:$Port/ - $($_.Exception.Message)"
  exit 1
}

Write-Host "Serving $Root"
Write-Host "  http://localhost:$Port/"
Write-Host "  http://localhost:$Port/test/browser/   (test suite)"
Write-Host 'Ctrl+C to stop.'

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    try {
      $relative = [Uri]::UnescapeDataString($request.Url.AbsolutePath).TrimStart('/')
      if ($relative -eq '') { $relative = 'index.html' }

      $target = Join-Path $Root $relative
      # Directory requests fall through to index.html inside them.
      if (Test-Path -LiteralPath $target -PathType Container) {
        $target = Join-Path $target 'index.html'
      }

      $full = [System.IO.Path]::GetFullPath($target)

      # Refuse anything that escapes the served root.
      if (-not $full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
        $response.StatusCode = 403
        $body = [Text.Encoding]::UTF8.GetBytes('403 Forbidden')
      } elseif (Test-Path -LiteralPath $full -PathType Leaf) {
        $response.StatusCode = 200
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        $type = $mime[$ext]
        if (-not $type) { $type = 'application/octet-stream' }
        $response.ContentType = $type
        $body = [System.IO.File]::ReadAllBytes($full)
      } else {
        $response.StatusCode = 404
        $response.ContentType = 'text/plain; charset=utf-8'
        $body = [Text.Encoding]::UTF8.GetBytes("404 Not Found: /$relative")
      }

      $response.Headers['Cache-Control'] = 'no-store, must-revalidate'
      $response.ContentLength64 = $body.Length
      $response.OutputStream.Write($body, 0, $body.Length)

      Write-Host ("{0,3} {1} {2}" -f $response.StatusCode, $request.HttpMethod, $request.Url.AbsolutePath)
    } catch {
      Write-Host "ERR $($request.Url.AbsolutePath): $($_.Exception.Message)"
    } finally {
      $response.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
