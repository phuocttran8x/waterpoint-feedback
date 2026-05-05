$base = 'http://localhost:4012'
$pass = $true
$results = [ordered]@{}

function Check($name, $cond, $detail = "") {
    $script:results[$name] = if ($cond) { "PASS" } else { "FAIL $detail"; $script:pass = $false }
}

# 1. Health
$h = Invoke-RestMethod "$base/health"
Check "01 Health OK" ($h.ok -eq $true)
Check "02 Mode in-memory" ($h.mode -eq "in-memory")

# 2. Submit feedback
$created = Invoke-RestMethod -Method Post -Uri "$base/api/feedback" `
    -ContentType 'application/json' `
    -Body (@{name='Nguyen Van A'; units=@('AQ1-1205','RV2-08-12'); content="Noi dung gop y thu nghiem day du."} | ConvertTo-Json)
Check "03 Submit returns id" ($created.feedback.id -match "^WP-")
Check "04 Submit hides name" (-not ($created.feedback.PSObject.Properties.Name -contains 'name'))
Check "05 Submit hides units" (-not ($created.feedback.PSObject.Properties.Name -contains 'units'))

# 3. Second submission for participant count test
Invoke-RestMethod -Method Post -Uri "$base/api/feedback" `
    -ContentType 'application/json' `
    -Body (@{name='Tran Thi B'; units=@('TA2-0311'); content="Gop y thu hai de kiem tra participant."} | ConvertTo-Json) | Out-Null

# 4. List feedback + pagination + stats
$list = Invoke-RestMethod "$base/api/feedback?page=1&pageSize=5"
Check "06 List returns items" ($list.items.Count -ge 2)
Check "07 List no name in items" (-not ($list.items[0].PSObject.Properties.Name -contains 'name'))
Check "08 List pagination total >= 2" ($list.pagination.totalItems -ge 2)
Check "09 Unique participants = 2" ($list.stats.uniqueParticipants -eq 2)

# 5. Search
$search = Invoke-RestMethod "$base/api/feedback?search=thu+hai"
Check "10 Search finds matching" ($search.pagination.totalItems -ge 1)

$noResult = Invoke-RestMethod "$base/api/feedback?search=khong_co_gi_ca"
Check "11 Search returns 0 for no match" ($noResult.pagination.totalItems -eq 0)

# 6. Validation errors
$badStatus = $null
try { Invoke-RestMethod -Method Post -Uri "$base/api/feedback" -ContentType 'application/json' -Body (@{name='A'; units=@(); content=""} | ConvertTo-Json) }
catch { $badStatus = $_.Exception.Response.StatusCode.value__ }
Check "12 Submit validation 400" ($badStatus -eq 400)

# 7. Edit ownership - wrong name
$forbiddenStatus = $null
try { Invoke-RestMethod -Method Put -Uri "$base/api/feedback/$($created.feedback.id)" -ContentType 'application/json' `
    -Body (@{name='Wrong Name'; units=@('AQ1-1205'); content='Fail'} | ConvertTo-Json) }
catch { $forbiddenStatus = $_.Exception.Response.StatusCode.value__ }
Check "13 Edit wrong owner 403" ($forbiddenStatus -eq 403)

# 8. Edit ownership - wrong unit only
$forbiddenStatus2 = $null
try { Invoke-RestMethod -Method Put -Uri "$base/api/feedback/$($created.feedback.id)" -ContentType 'application/json' `
    -Body (@{name='Nguyen Van A'; units=@('ZZ1-9999'); content='Fail'} | ConvertTo-Json) }
catch { $forbiddenStatus2 = $_.Exception.Response.StatusCode.value__ }
Check "14 Edit wrong unit 403" ($forbiddenStatus2 -eq 403)

# 9. Edit ownership - correct (partial unit match)
$editOk = Invoke-RestMethod -Method Put -Uri "$base/api/feedback/$($created.feedback.id)" -ContentType 'application/json' `
    -Body (@{name='Nguyen Van A'; units=@('AQ1-1205'); content='Noi dung da cap nhat chinh xac.'} | ConvertTo-Json)
Check "15 Edit valid owner OK" ($editOk.feedback.content -eq 'Noi dung da cap nhat chinh xac.')
Check "16 Edit hides name in response" (-not ($editOk.feedback.PSObject.Properties.Name -contains 'name'))

# 10. Edit 404 non-existent
$notFoundStatus = $null
try { Invoke-RestMethod -Method Put -Uri "$base/api/feedback/WP-INVALID" -ContentType 'application/json' `
    -Body (@{name='X'; units=@('Y'); content='Z'} | ConvertTo-Json) }
catch { $notFoundStatus = $_.Exception.Response.StatusCode.value__ }
Check "17 Edit non-existent 404" ($notFoundStatus -eq 404)

# 11. Admin login - bad password
$loginBadStatus = $null
try { Invoke-RestMethod -Method Post -Uri "$base/api/admin/login" -ContentType 'application/json' -Body (@{password='wrongpass'} | ConvertTo-Json) }
catch { $loginBadStatus = $_.Exception.Response.StatusCode.value__ }
Check "18 Admin login bad pwd 401" ($loginBadStatus -eq 401)

# 12. Admin login - correct
$loginOk = Invoke-RestMethod -Method Post -Uri "$base/api/admin/login" -ContentType 'application/json' -Body (@{password='admin123'} | ConvertTo-Json)
Check "19 Admin login gets token" ($loginOk.token.Length -gt 20)

$authHdr = @{Authorization = "Bearer $($loginOk.token)"}

# 13. Export anonymized
$anon = Invoke-RestMethod -Uri "$base/api/admin/export/anonymized" -Headers $authHdr
Check "20 Anon export total >= 2" ($anon.totalFeedbacks -ge 2)
Check "21 Anon hides name" (-not ($anon.feedbacks[0].PSObject.Properties.Name -contains 'name'))
Check "22 Anon hides units" (-not ($anon.feedbacks[0].PSObject.Properties.Name -contains 'units'))
Check "23 Anon has uniqueParticipants" ($anon.uniqueParticipants -ge 2)

# 14. Export full
$full = Invoke-RestMethod -Uri "$base/api/admin/export/full" -Headers $authHdr
Check "24 Full export has name" ($full.feedbacks[0].PSObject.Properties.Name -contains 'name')
Check "25 Full export has units" ($full.feedbacks[0].PSObject.Properties.Name -contains 'units')
Check "26 Full export has content" ($full.feedbacks[0].content.Length -gt 0)

# 15. Report HTML
$rspRaw = Invoke-WebRequest -Uri "$base/api/admin/export/report" -Headers $authHdr
Check "27 Report status 200" ($rspRaw.StatusCode -eq 200)
Check "28 Report content-type HTML" ($rspRaw.Headers.'Content-Type' -like '*text/html*')
Check "29 Report contains name data" ($rspRaw.Content -like '*Nguyen Van A*')
Check "30 Report contains stat cards" ($rspRaw.Content -like '*stat-card*')
Check "31 Report has print button" ($rspRaw.Content -like '*window.print*')

# 16. Unauthenticated access
$unauthStatus = $null
try { Invoke-RestMethod "$base/api/admin/export/full" }
catch { $unauthStatus = $_.Exception.Response.StatusCode.value__ }
Check "32 Unauth export 401" ($unauthStatus -eq 401)

$unauthReport = $null
try { Invoke-RestMethod "$base/api/admin/export/report" }
catch { $unauthReport = $_.Exception.Response.StatusCode.value__ }
Check "33 Unauth report 401" ($unauthReport -eq 401)

# Print results
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  TEST RESULTS - Waterpoint Feedback API  " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
foreach ($k in $results.Keys) {
    $v = $results[$k]
    if ($v -eq "PASS") { Write-Host "  [PASS] $k" -ForegroundColor Green }
    else { Write-Host "  [FAIL] $k  -- $v" -ForegroundColor Red }
}
Write-Host "------------------------------------------" -ForegroundColor Cyan
$passCount = ($results.Values | Where-Object { $_ -eq "PASS" }).Count
$total = $results.Count
if ($pass) {
    Write-Host "  ALL $total/$total TESTS PASSED" -ForegroundColor Green
} else {
    Write-Host "  $passCount/$total passed -- CHECK FAILURES ABOVE" -ForegroundColor Red
}
Write-Host "==========================================" -ForegroundColor Cyan
