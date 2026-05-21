# End-to-end live test for the token persistence rework (Windows / PowerShell).
# Uses curl.exe to avoid PS parser quirks. Run from repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\test-token-live.ps1
# Optional:
#   -Key test-key   -ProxyHost http://127.0.0.1:8787

param(
    [string]$Key = "test-key",
    [string]$ProxyHost = "http://127.0.0.1:8787"
)

$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)

$auth = "Authorization: Bearer $Key"
$ct   = "Content-Type: application/json"
$tmp  = $env:TEMP
if (-not $tmp) { $tmp = "." }

function Hr {
    param([string]$n, [string]$title)
    Write-Host ""
    Write-Host "==========================================================="
    Write-Host ("[" + $n + "] " + $title)
    Write-Host "==========================================================="
}

Hr "1/6" "health"
& curl.exe -sS "$ProxyHost/health" -w "`nHTTP=%{http_code}`n"

Hr "2/6" "GET /v1/accounts before traffic"
$accBeforePath = Join-Path $tmp "magai-acc-before.json"
& curl.exe -sS "$ProxyHost/v1/accounts" -H $auth -o $accBeforePath -w "HTTP=%{http_code}`n"
node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const list=d.data||[];console.log(JSON.stringify({total:list.length,enabled:list.filter(x=>x.enabled).length,hasPasswordCount:list.filter(x=>x.hasPassword).length,hasRefreshCount:list.filter(x=>x.hasRefreshToken).length,sample:list.slice(0,3).map(x=>({name:x.name,enabled:x.enabled,hasPassword:x.hasPassword,hasRefreshToken:x.hasRefreshToken,lastRefreshAt:x.lastRefreshAt,lastError:x.lastError}))},null,2));" $accBeforePath

Hr "3/6" "GET /v1/models forces a Supabase refresh end to end"
& curl.exe -sS "$ProxyHost/v1/models" -H $auth -w "`nHTTP=%{http_code}`n" -o (Join-Path $tmp "magai-models.json")
$modelBody = Get-Content -Raw (Join-Path $tmp "magai-models.json")
if ($modelBody.Length -gt 2000) { $modelBody = $modelBody.Substring(0,2000) + "...[truncated]" }
Write-Host $modelBody

Hr "4/6" "10 concurrent chat completions stress refreshPromise dedup"
# Use a file for the JSON body to avoid PowerShell mangling embedded quotes
# when passing through curl.exe --data.
$bodyFile = Join-Path $tmp "magai-body.json"
Set-Content -Path $bodyFile -Value '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"reply OK only"}]}' -Encoding ascii -NoNewline
$jobs = 1..10 | ForEach-Object {
    $i = $_
    $url = "$ProxyHost/v1/chat/completions"
    $outFile = Join-Path $tmp ("magai-c" + $i + ".json")
    Start-Job -ScriptBlock {
        param($i, $url, $key, $bodyFile, $outFile)
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $stat = & curl.exe -sS $url `
            -H ("Authorization: Bearer " + $key) `
            -H "Content-Type: application/json" `
            --data-binary ("@" + $bodyFile) `
            -o $outFile `
            -w "%{http_code}"
        $sw.Stop()
        [pscustomobject]@{ i = $i; status = $stat; ms = $sw.ElapsedMilliseconds; out = $outFile }
    } -ArgumentList $i, $url, $Key, $bodyFile, $outFile
}
$jobs | Wait-Job | Out-Null
$results = $jobs | ForEach-Object { Receive-Job $_ }
$jobs | Remove-Job
$results | Sort-Object i | ForEach-Object {
    $head = ""
    if (Test-Path $_.out) {
        $raw = Get-Content -Raw $_.out
        if ($raw.Length -gt 200) { $head = $raw.Substring(0,200) } else { $head = $raw }
    }
    Write-Host ("[req-" + $_.i + "] HTTP=" + $_.status + " time=" + $_.ms + "ms")
    Write-Host ("    body: " + $head)
}

Hr "5/6" "GET /v1/accounts again - lastRefreshAt should have advanced"
$accAfterPath = Join-Path $tmp "magai-acc-after.json"
& curl.exe -sS "$ProxyHost/v1/accounts" -H $auth -o $accAfterPath -w "HTTP=%{http_code}`n"
node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify((d.data||[]).map(x=>({name:x.name,lastRefreshAt:x.lastRefreshAt,lastUsedAt:x.lastUsedAt,lastError:x.lastError})),null,2));" $accAfterPath

Hr "6/6" "accounts.json on disk - refresh_token rotated since boot"
node -e "const a=JSON.parse(require('fs').readFileSync('apps/server/accounts.json','utf8'));console.log(JSON.stringify(a.map(x=>({name:x.name,refreshHead:(x.supabaseRefreshToken||'').slice(0,16),refreshLen:(x.supabaseRefreshToken||'').length,hasEmail:!!x.supabaseEmail,hasPassword:!!x.supabasePassword})),null,2));"

Write-Host ""
Write-Host "DONE. Paste the entire output back to Claude."
