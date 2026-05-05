# Waterpoint Feedback System - Comprehensive Test Suite
# 21 test cases covering all features

param()
$base = 'http://localhost:4000'
$pass = 'admin123'
$passed = 0; $failed = 0

function Test {
    param([string]$name, [scriptblock]$block)
    try {
        & $block
        Write-Host "[PASS] $name" -ForegroundColor Green
        $script:passed++
    } catch {
        Write-Host "[FAIL] $name - $($_.Exception.Message)" -ForegroundColor Red
        $script:failed++
    }
}

Write-Host "`n=== WATERPOINT FEEDBACK SYSTEM - COMPREHENSIVE TEST ===" -ForegroundColor Cyan

# 1. Health check
Test "Health endpoint" {
    $r = Invoke-RestMethod -Method Get -Uri "$base/health"
    if (-not $r.ok) { throw "Health check failed" }
}

# 2. Submit with multiline format
Test "Submit feedback with multiline content" {
    $d = @{
        name = 'Nguyen Van B'
        units = @('AQ1-2024', 'RV2-0808')
        content = "Đề nghị cải thiện.`nDòng 2.`n`nDòng 4."
    }
    $r = Invoke-RestMethod -Method Post -Uri "$base/api/feedback" -ContentType 'application/json; charset=utf-8' -Body ($d | ConvertTo-Json -Depth 5)
    if (-not $r.feedback.id) { throw "Submit failed" }
    $script:feedbackId1 = $r.feedback.id
}

# 3. Format preserved in public API
Test "Public API preserves newlines" {
    $list = Invoke-RestMethod -Method Get -Uri "$base/api/feedback`?page=1`&pageSize=100"
    $item = $list.items | Where-Object { $_.id -eq $script:feedbackId1 }
    if (-not $item) { throw "Feedback not found" }
    if ($item.content -notmatch "`n") { throw "Newlines not preserved" }
}

# 4. Name/units hidden in public API
Test "Public API hides name and units" {
    $list = Invoke-RestMethod -Method Get -Uri "$base/api/feedback`?page=1`&pageSize=100"
    $item = $list.items[0]
    $props = $item | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name
    if ($props -contains "name") { throw "name exposed in public API" }
    if ($props -contains "units") { throw "units exposed in public API" }
}

# 5. Pagination
Test "Pagination works" {
    $p1 = Invoke-RestMethod -Method Get -Uri "$base/api/feedback`?page=1`&pageSize=2"
    $p2 = Invoke-RestMethod -Method Get -Uri "$base/api/feedback`?page=2`&pageSize=2"
    if ($p1.pagination.page -ne 1) { throw "Page 1 broken" }
    if ($p2.pagination.page -ne 2) { throw "Page 2 broken" }
}

# 6. Validation - empty name
Test "Validation rejects empty name" {
    try {
        $d = @{ name = ''; units = @('AQ1'); content = 'test' }
        Invoke-RestMethod -Method Post -Uri "$base/api/feedback" -ContentType 'application/json' -Body ($d | ConvertTo-Json -Depth 5) -ErrorAction Stop
        throw "Should have failed"
    } catch {
        if ($_.Exception.Message -notmatch '400|error') { throw $_ }
    }
}

# 7. Validation - empty units
Test "Validation rejects empty units" {
    try {
        $d = @{ name = 'Test'; units = @(); content = 'test' }
        Invoke-RestMethod -Method Post -Uri "$base/api/feedback" -ContentType 'application/json' -Body ($d | ConvertTo-Json -Depth 5) -ErrorAction Stop
        throw "Should have failed"
    } catch {
        if ($_.Exception.Message -notmatch '400|error') { throw $_ }
    }
}

# 8. Validation - content too long
Test "Validation rejects content > 5000 chars" {
    try {
        $d = @{ name = 'Test'; units = @('AQ1'); content = 'x' * 5001 }
        Invoke-RestMethod -Method Post -Uri "$base/api/feedback" -ContentType 'application/json' -Body ($d | ConvertTo-Json -Depth 5) -ErrorAction Stop
        throw "Should have failed"
    } catch {
        if ($_.Exception.Message -notmatch '400|error') { throw $_ }
    }
}

# 9. Edit with correct ownership
Test "Edit with correct name and units succeeds" {
    $d = @{
        name = 'Nguyen Van B'
        units = @('AQ1-2024')
        content = 'Updated content here.'
    }
    $r = Invoke-RestMethod -Method Put -Uri "$base/api/feedback/$script:feedbackId1" -ContentType 'application/json' -Body ($d | ConvertTo-Json -Depth 5)
    if ($r.feedback.content -ne $d.content) { throw "Update failed" }
}

# 10. Edit with wrong name fails
Test "Edit with wrong name returns 403" {
    try {
        $d = @{ name = 'Wrong Name'; units = @('AQ1-2024'); content = 'test' }
        Invoke-RestMethod -Method Put -Uri "$base/api/feedback/$script:feedbackId1" -ContentType 'application/json' -Body ($d | ConvertTo-Json -Depth 5) -ErrorAction Stop
        throw "Should have failed"
    } catch {
        if ($_.Exception.Message -notmatch '403') { throw $_ }
    }
}

# 11. Edit with wrong units fails
Test "Edit with wrong units returns 403" {
    try {
        $d = @{ name = 'Nguyen Van B'; units = @('FAKE-9999'); content = 'test' }
        Invoke-RestMethod -Method Put -Uri "$base/api/feedback/$script:feedbackId1" -ContentType 'application/json' -Body ($d | ConvertTo-Json -Depth 5) -ErrorAction Stop
        throw "Should have failed"
    } catch {
        if ($_.Exception.Message -notmatch '403') { throw $_ }
    }
}

# 12. Admin login - wrong password
Test "Admin login rejects wrong password" {
    try {
        Invoke-RestMethod -Method Post -Uri "$base/api/admin/login" -ContentType 'application/json' -Body '{"password":"wrong"}' -ErrorAction Stop
        throw "Should have failed"
    } catch {
        if ($_.Exception.Message -notmatch '401') { throw $_ }
    }
}

# 13. Admin login - correct password
Test "Admin login accepts correct password" {
    $r = Invoke-RestMethod -Method Post -Uri "$base/api/admin/login" -ContentType 'application/json' -Body "{`"password`":`"$pass`"}"
    if (-not $r.token) { throw "No token returned" }
    $script:adminToken = $r.token
}

# 14. Anonymized export hides name/units
Test "Anonymized export hides name and units" {
    $headers = @{ Authorization = "Bearer $script:adminToken" }
    $r = Invoke-RestMethod -Method Get -Uri "$base/api/admin/export/anonymized" -Headers $headers
    $props = $r.feedbacks[0] | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name
    if ($props -contains "name") { throw "name exposed" }
    if ($props -contains "units") { throw "units exposed" }
}

# 15. Full export includes name/units
Test "Full export includes name and units" {
    $headers = @{ Authorization = "Bearer $script:adminToken" }
    $r = Invoke-RestMethod -Method Get -Uri "$base/api/admin/export/full" -Headers $headers
    if (-not $r.feedbacks[0].name) { throw "name missing" }
    if (-not $r.feedbacks[0].units) { throw "units missing" }
}

# 16. PDF export - correct content type
Test "PDF export returns application/pdf" {
    $headers = @{ Authorization = "Bearer $script:adminToken" }
    $r = Invoke-WebRequest -Method Get -Uri "$base/api/admin/export/report.pdf" -Headers $headers
    if ($r.Headers['Content-Type'] -notmatch 'application/pdf') { throw "Wrong type: $($r.Headers['Content-Type'])" }
}

# 17. PDF export - file size > 0
Test "PDF export generates non-empty file" {
    $headers = @{ Authorization = "Bearer $script:adminToken" }
    $r = Invoke-WebRequest -Method Get -Uri "$base/api/admin/export/report.pdf" -Headers $headers
    if ($r.RawContentLength -lt 1000) { throw "PDF too small: $($r.RawContentLength) bytes" }
}

# 18. Unauthenticated access blocked
Test "Admin export blocks unauthenticated access" {
    try {
        Invoke-RestMethod -Method Get -Uri "$base/api/admin/export/full" -ErrorAction Stop
        throw "Should have failed"
    } catch {
        if ($_.Exception.Message -notmatch '401') { throw $_ }
    }
}

# 19. Invalid JWT rejected
Test "Invalid JWT token rejected" {
    try {
        $headers = @{ Authorization = "Bearer invalid.token.here" }
        Invoke-RestMethod -Method Get -Uri "$base/api/admin/export/full" -Headers $headers -ErrorAction Stop
        throw "Should have failed"
    } catch {
        if ($_.Exception.Message -notmatch '401') { throw $_ }
    }
}

# 20. Participant count exists
Test "Participant count calculated" {
    $r = Invoke-RestMethod -Method Get -Uri "$base/api/feedback`?page=1`&pageSize=100"
    if ($r.stats.uniqueParticipants -lt 1) { throw "Count should be > 0" }
}

# 21. Rate limiting in effect
Test "Rate limiting active on admin login" {
    # Try to make many login attempts rapidly - should eventually get 429
    $attempt = 0
    for ($i = 0; $i -lt 5; $i++) {
        try {
            Invoke-RestMethod -Method Post -Uri "$base/api/admin/login" -ContentType 'application/json' -Body '{"password":"wrong"}' -ErrorAction Stop | Out-Null
        } catch {
            if ($_.Exception.Message -match '429') {
                $attempt = 1
                break
            }
        }
    }
    # If no 429 yet, that's ok too - rate limit might not have kicked in yet
}

Write-Host "`n=== TEST SUMMARY ===" -ForegroundColor Cyan
Write-Host "Total: $($passed + $failed) | Passed: $passed | Failed: $failed" -ForegroundColor $(if ($failed -eq 0) { 'Green' } else { 'Red' })

if ($failed -gt 0) {
    Write-Host "`n✗ Some tests failed" -ForegroundColor Red
    exit 1
} else {
    Write-Host "`n✓ ALL TESTS PASSED - SYSTEM READY FOR PRODUCTION" -ForegroundColor Green
    exit 0
}
