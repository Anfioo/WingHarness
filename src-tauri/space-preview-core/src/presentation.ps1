$ErrorActionPreference = 'Stop'
$app = $null
$deck = $null
$security = $null
$alerts = $null
$failed = $false
try {
    $app = New-Object -ComObject PowerPoint.Application
    $security = $app.AutomationSecurity
    $alerts = $app.DisplayAlerts
    $app.AutomationSecurity = 3
    $app.DisplayAlerts = 1
    $deck = $app.Presentations.Open($env:SPACEPREVIEW_PPT_SOURCE, -1, 0, 0)
    $deck.SaveAs($env:SPACEPREVIEW_PPT_OUTPUT, 32)
} catch {
    $failed = $true
} finally {
    if ($null -ne $deck) {
        try { $deck.Close() } catch {}
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($deck)
    }
    if ($null -ne $app) {
        try {
            if ($null -ne $security) { $app.AutomationSecurity = $security }
            if ($null -ne $alerts) { $app.DisplayAlerts = $alerts }
            if ($app.Presentations.Count -eq 0) { $app.Quit() }
        } catch {}
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)
    }
}
if ($failed) { exit 1 }
