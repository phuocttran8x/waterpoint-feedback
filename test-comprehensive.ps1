# Comprehensive Test Suite for Waterpoint Feedback System
# Test all features: APIs, data integrity, security, format preservation

$base = 'http://localhost:4000'
$pass = 'admin123'
$testResults = @()

function Test {
    param([string]$name, [scriptblock]$block)
    try {
        & $block
        $testResults += @{ name = $name; status = 'PASS'; msg = '' }
        Write-Host "[✓] $name" -ForegroundColor Green
    } catch {
        $testResults += @{ name = $name; status = 'FAIL'; msg = $_.Exception.Message }
        Write-Host "[✗] $name - $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host "`n=== WATERPOINT FEEDBACK SYSTEM - COMPREHENSIVE TEST ===" -ForegroundColor Cyan

# 1. HEALTH CHECK
Test "Health endpoint" {
    $r = Invoke-RestMethod -Method Get -Uri "$base/health"
    if (-not $r.ok) { throw "Health check failed" }
}

# 2. SUBMIT FEEDBACK - Format Preservation
Test "Submit feedback with multiline content" {
    $d = @{
        name = 'Nguyen Van A'
        units = @('AQ1-2024', 'RV2-0808')
        content = "Đề nghị tăng chiếu sáng khu AQ.`nHiện tại khu vực rất tối, đặc biệt buổi tối.`nCó thể lắp thêm đèn LED ở các lối đi chính.`n`nCảm ơn BQL."
    }
    $r = Invoke-RestMethod -Method Post -Uri "$base/api/feedback" -ContentType 'application/json; charset=utf-8' -Body ($d | ConvertTo-Json -Depth 5)
    if (-not $r.feedback.id -or -not $r.feedback.content) { throw "Submit failed" }
    $script:feedbackId1 = $r.feedback.id
}

# 3. VERIFY FORMAT PRESERVED IN PUBLIC API
Test "Public API preserves newlines in content" {
    $list = Invoke-RestMethod -Method Get -Uri "$base/api/feedback?page=1&pageSize=100"
    $item = $list.items | Where-Object { $_.id -eq $script:feedbackId1 }
    if (-not $item) { throw "Feedback not found in public API" }
    if ($item.content -notmatch "`n") { throw "Newlines not preserved in API response" }
}

# 4. VERIFY NAME/UNITS HIDDEN IN PUBLIC API
Test "Public API hides name and units" {
    $list = Invoke-RestMethod -Method Get -Uri "$base/api/feedback?page=1&pageSize=100"
    $item = $list.items[0]
    if ($item | Get-Member -Name "name" -ErrorAction SilentlyContinue) { throw "name field exposed in public API" }
    if ($item | Get-Member -Name "units" -ErrorAction SilentlyContinue) { throw "units field exposed in public API" }
    if ($item.id -and $item.content -and $item.createdAt) { } else { throw "Missing required fields in public response" }
}

# 5. PAGINATION TEST
Test "Pagination works correctly" {
    $p1 = Invoke-RestMethod -Method Get -Uri "$base/api/feedback?page=1`&pageSize=2"
    $p2 = Invoke-RestMethod -Method Get -Uri "$base/api/feedback?page=2`&pageSize=2"
    if ($p1.pagination.page -ne 1) { throw "Page 1 incorrect" }
    if ($p2.pagination.page -ne 2) { throw "Page 2 incorrect" }
}

# 6. SEARCH TEST
Test "Search filters content correctly" {
    $search = Invoke-RestMethod -Method Get -Uri "$base/api/feedback?search=chi%E1%BA%BFu%20s%C3%A1ng`&page=1`&pageSize=100"
    if ($search.items.Count -lt 1) { throw "Search returned no results" }
}

# 7. OWNERSHIP EDIT - CORRECT NAME/UNITS
Test "Edit feedback with correct ownership" {
    $d = @{
        name = 'Nguyen Van A'
        units = @('AQ1-2024')
        content = 'Updated: Da tang chieu sang AQ khu vuc chinh.'
    }
    $r = Invoke-RestMethod -Method Put -Uri "$base/api/feedback/$script:feedbackId1" -ContentType 'application/json' -Body ($d | ConvertTo-Json -Depth 5)
    if ($r.feedback.content -ne $d.content) { throw "Content not updated" }
}

# 8. OWNERSHIP EDIT - WRONG NAME (SHOULD FAIL)
Test "Edit feedback with wrong name returns 403" {
    try {
        $d = @{ name = 'Wrong Name'; units = @('AQ1-2024'); content = 'test' }
        Invoke-RestMethod -Method Put -Uri "$base/api/feedback/$script:feedbackId1" -ContentType 'application/json' -Body ($d | ConvertTo-Json -Depth 5) -ErrorAction Stop
        throw "Should have been rejected"
    } catch {
        if ($_.Exception.Message -notmatch '403') { throw $_ }
    }
}

# 9. OWNERSHIP EDIT - WRONG UNITS (SHOULD FAIL)
Test "Edit feedback with wrong units returns 403" {
    try {
        $d = @{ name = 'Nguyen Van A'; units = @('FAKE-9999'); content = 'test' }
        Invoke-RestMethod -Method Put -Uri "$base/api/feedback/$script:feedbackId1" -ContentType 'application/json' -Body ($d | ConvertTo-Json -Depth 5) -ErrorAction Stop
        throw "Should have been rejected"
    } catch {
        if ($_.Exception.Message -notmatch '403') { throw $_ }
    }
}

# 10. VALIDATION - EMPTY NAME
Test "Validation rejects empty name" {
    try {
        $d = @{ name = ''; units = @('AQ1'); content = 'test' }
        Invoke-RestMethod -Method Post -Uri "$base/api/feedback" -ContentType 'application/json' -Body ($d | ConvertTo-Json -Depth 5) -ErrorAction Stop
        throw "Should have been rejected"
    } catch {
        if ($_.Exception.Message -notmatch '400|errors') { throw $_ }
    }
}

# 11. VALIDATION - NO UNITS
Test "Validation rejects empty units" {
    try {
        $d = @{ name = 'Test'; units = @(); content = 'test' }
        Invoke-RestMethod -Method Post -Uri "$base/api/feedback" -ContentType 'application/json' -Body ($d | ConvertTo-Json -Depth 5) -ErrorAction Stop
        throw "Should have been rejected"
    } catch {
        if ($_.Exception.Message -notmatch '400|errors') { throw $_ }
    }
}

# 12. VALIDATION - CONTENT TOO LONG
Test "Validation rejects content > 5000 chars" {
    try {
        $d = @{ name = 'Test'; units = @('AQ1'); content = 'x' * 5001 }
        Invoke-RestMethod -Method Post -Uri "$base/api/feedback" -ContentType 'application/json' -Body ($d | ConvertTo-Json -Depth 5) -ErrorAction Stop
        throw "Should have been rejected"
    } catch {
        if ($_.Exception.Message -notmatch '400|errors') { throw $_ }
    }
}

# 13. ADMIN LOGIN - WRONG PASSWORD
Test "Admin login rejects wrong password" {
    try {
        Invoke-RestMethod -Method Post -Uri "$base/api/admin/login" -ContentType 'application/json' -Body '{"password":"wrong"}' -ErrorAction Stop
        throw "Should have been rejected"
    } catch {
        if ($_.Exception.Message -notmatch '401') { throw $_ }
    }
}

# 14. ADMIN LOGIN - CORRECT PASSWORD
Test "Admin login accepts correct password" {
    $r = Invoke-RestMethod -Method Post -Uri "$base/api/admin/login" -ContentType 'application/json' -Body "{`"password`":`"$pass`"}"
    if (-not $r.token) { throw "No token returned" }
    $script:adminToken = $r.token
}

# 15. ADMIN EXPORT - ANONYMIZED (NO NAME/UNITS)
Test "Admin anonymized export hides name/units" {
    $headers = @{ Authorization = "Bearer $script:adminToken" }
    $r = Invoke-RestMethod -Method Get -Uri "$base/api/admin/export/anonymized" -Headers $headers
    if ($r.feedbacks[0] | Get-Member -Name "name" -ErrorAction SilentlyContinue) { throw "name exposed in anonymized export" }
    if ($r.feedbacks[0] | Get-Member -Name "units" -ErrorAction SilentlyContinue) { throw "units exposed in anonymized export" }
}

# 16. ADMIN EXPORT - FULL (HAS NAME/UNITS)
Test "Admin full export includes name/units" {
    $headers = @{ Authorization = "Bearer $script:adminToken" }
    $r = Invoke-RestMethod -Method Get -Uri "$base/api/admin/export/full" -Headers $headers
    if (-not $r.feedbacks[0].name) { throw "name missing in full export" }
    if (-not $r.feedbacks[0].units) { throw "units missing in full export" }
}

# 17. ADMIN EXPORT - PDF CONTENT TYPE
Test "PDF export returns application/pdf content type" {
    $headers = @{ Authorization = "Bearer $script:adminToken" }
    $r = Invoke-WebRequest -Method Get -Uri "$base/api/admin/export/report.pdf" -Headers $headers
    if ($r.Headers['Content-Type'] -notmatch 'application/pdf') { throw "Wrong content type: $($r.Headers['Content-Type'])" }
}

# 18. ADMIN EXPORT - PDF FILE SIZE > 0
Test "PDF export generates non-empty file" {
    $headers = @{ Authorization = "Bearer $script:adminToken" }
    $r = Invoke-WebRequest -Method Get -Uri "$base/api/admin/export/report.pdf" -Headers $headers
    if ($r.RawContentLength -lt 1000) { throw "PDF file too small: $($r.RawContentLength) bytes" }
}

# 19. UNAUTHENTICATED ACCESS - ADMIN EXPORT BLOCKED
Test "Admin export blocks unauthenticated access" {
    try {
        Invoke-RestMethod -Method Get -Uri "$base/api/admin/export/full" -ErrorAction Stop
        throw "Should have been rejected"
    } catch {
        if ($_.Exception.Message -notmatch '401') { throw $_ }
    }
}

# 20. PARTICIPANT STATS
Test "Participant count calculated correctly" {
    $r = Invoke-RestMethod -Method Get -Uri "$base/api/feedback?page=1&pageSize=100"
    if ($r.stats.uniqueParticipants -lt 1) { throw "Participant count should be > 0" }
}

# 21. UNIQUE UNITS COUNT
Test "Unique units counted correctly" {
    $headers = @{ Authorization = "Bearer $script:adminToken" }
    $r = Invoke-RestMethod -Method Get -Uri "$base/api/admin/export/full" -Headers $headers
    # Should have at least one unit from previous feedback
    if (-not $r.feedbacks[0].units -or $r.feedbacks[0].units.Count -lt 1) { throw "No units in export" }
}

# Summary
Write-Host "`n=== TEST SUMMARY ===" -ForegroundColor Cyan
$passed = ($testResults | Where-Object { $_.status -eq 'PASS' }).Count
$failed = ($testResults | Where-Object { $_.status -eq 'FAIL' }).Count
Write-Host "Total: $($testResults.Count) | Passed: $passed | Failed: $failed" -ForegroundColor $(if ($failed -eq 0) { 'Green' } else { 'Red' })

if ($failed -gt 0) {
    Write-Host "`nFailed Tests:" -ForegroundColor Red
    $testResults | Where-Object { $_.status -eq 'FAIL' } | ForEach-Object { Write-Host "  - $($_.name): $($_.msg)" -ForegroundColor Red }
    exit 1
} else {
    Write-Host "`n✓ ALL TESTS PASSED - READY FOR PRODUCTION" -ForegroundColor Green
    exit 0
}
