// Waterpoint Feedback System - Comprehensive Test Suite (21 tests)
const http = require('http');
const base = 'http://localhost:4000';
const pass = 'admin123';
let passed = 0,
    failed = 0;
let adminToken = '';
let feedbackId1 = '';

function fetch_req(method, path, body = null, token = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, base);
        const opts = {
            method,
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            }
        };
        if (token) opts.headers.Authorization = `Bearer ${token}`;

        const proto = url.protocol === 'https:' ? require('https') : http;
        const req = proto.request(url, opts, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({ status: res.statusCode, data: json, headers: res.headers });
                } catch {
                    resolve({ status: res.statusCode, data, headers: res.headers });
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function test(name, fn) {
    try {
        await fn();
        console.log(`[PASS] ${name}`);
        passed++;
    } catch (e) {
        console.log(`[FAIL] ${name} - ${e.message}`);
        failed++;
    }
}

async function run() {
    console.log('\n=== WATERPOINT FEEDBACK SYSTEM - COMPREHENSIVE TEST ===\n');

    await test('Health endpoint', async() => {
        const r = await fetch_req('GET', '/health');
        if (!r.data.ok) throw new Error('Health check failed');
    });

    await test('Submit feedback with multiline', async() => {
        const d = {
            name: 'Nguyen Van C',
            units: ['AQ1-2024', 'RV2-0808'],
            content: 'Đề nghị cải thiện.\nDòng 2.\n\nDòng 4.'
        };
        const r = await fetch_req('POST', '/api/feedback', d);
        if (r.status !== 201) throw new Error(`Status ${r.status}`);
        if (!r.data.feedback.id) throw new Error('No feedback id');
        feedbackId1 = r.data.feedback.id;
    });

    await test('Public API preserves newlines', async() => {
        const r = await fetch_req('GET', '/api/feedback?page=1&pageSize=100');
        const item = r.data.items.find(i => i.id === feedbackId1);
        if (!item) throw new Error('Feedback not found');
        if (!item.content.includes('\n')) throw new Error('Newlines not preserved');
    });

    await test('Public API hides name/units', async() => {
        const r = await fetch_req('GET', '/api/feedback?page=1&pageSize=100');
        const item = r.data.items[0];
        if ('name' in item) throw new Error('name exposed');
        if ('units' in item) throw new Error('units exposed');
    });

    await test('Pagination page 1', async() => {
        const r = await fetch_req('GET', '/api/feedback?page=1&pageSize=2');
        if (r.data.pagination.page !== 1) throw new Error('Page 1 broken');
    });

    await test('Pagination page 2', async() => {
        const r = await fetch_req('GET', '/api/feedback?page=2&pageSize=2');
        if (r.data.pagination.page !== 2) throw new Error('Page 2 broken');
    });

    await test('Validation rejects empty name', async() => {
        const r = await fetch_req('POST', '/api/feedback', { name: '', units: ['AQ1'], content: 'test' });
        if (r.status !== 400) throw new Error(`Expected 400, got ${r.status}`);
    });

    await test('Validation rejects empty units', async() => {
        const r = await fetch_req('POST', '/api/feedback', { name: 'Test', units: [], content: 'test' });
        if (r.status !== 400) throw new Error(`Expected 400, got ${r.status}`);
    });

    await test('Validation rejects content > 5000 chars', async() => {
        const r = await fetch_req('POST', '/api/feedback', { name: 'Test', units: ['AQ1'], content: 'x'.repeat(5001) });
        if (r.status !== 400) throw new Error(`Expected 400, got ${r.status}`);
    });

    await test('Edit with correct ownership succeeds', async() => {
        const r = await fetch_req('PUT', `/api/feedback/${feedbackId1}`, {
            name: 'Nguyen Van C',
            units: ['AQ1-2024'],
            content: 'Updated content.'
        });
        if (r.status !== 200) throw new Error(`Status ${r.status}`);
        if (r.data.feedback.content !== 'Updated content.') throw new Error('Update failed');
    });

    await test('Edit with wrong name returns 403', async() => {
        const r = await fetch_req('PUT', `/api/feedback/${feedbackId1}`, {
            name: 'Wrong Name',
            units: ['AQ1-2024'],
            content: 'test'
        });
        if (r.status !== 403) throw new Error(`Expected 403, got ${r.status}`);
    });

    await test('Edit with wrong units returns 403', async() => {
        const r = await fetch_req('PUT', `/api/feedback/${feedbackId1}`, {
            name: 'Nguyen Van C',
            units: ['FAKE-9999'],
            content: 'test'
        });
        if (r.status !== 403) throw new Error(`Expected 403, got ${r.status}`);
    });

    await test('Admin login rejects wrong password', async() => {
        const r = await fetch_req('POST', '/api/admin/login', { password: 'wrong' });
        if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
    });

    await test('Admin login accepts correct password', async() => {
        const r = await fetch_req('POST', '/api/admin/login', { password: pass });
        if (r.status !== 200) throw new Error(`Status ${r.status}`);
        if (!r.data.token) throw new Error('No token');
        adminToken = r.data.token;
    });

    await test('Anonymized export hides name/units', async() => {
        const r = await fetch_req('GET', '/api/admin/export/anonymized', null, adminToken);
        if (r.status !== 200) throw new Error(`Status ${r.status}`);
        if ('name' in r.data.feedbacks[0]) throw new Error('name exposed');
        if ('units' in r.data.feedbacks[0]) throw new Error('units exposed');
    });

    await test('Full export includes name/units', async() => {
        const r = await fetch_req('GET', '/api/admin/export/full', null, adminToken);
        if (r.status !== 200) throw new Error(`Status ${r.status}`);
        if (!r.data.feedbacks[0].name) throw new Error('name missing');
        if (!r.data.feedbacks[0].units) throw new Error('units missing');
    });

    await test('PDF export returns application/pdf', async() => {
        const r = await fetch_req('GET', '/api/admin/export/report.pdf', null, adminToken);
        if (r.status !== 200) throw new Error(`Status ${r.status}`);
        if (!r.headers['content-type'].includes('application/pdf')) throw new Error(`Wrong type: ${r.headers['content-type']}`);
    });

    await test('PDF export file > 1KB', async() => {
        const r = await fetch_req('GET', '/api/admin/export/report.pdf', null, adminToken);
        if (r.status !== 200) throw new Error(`Status ${r.status}`);
        if (typeof r.data === 'string' && r.data.length < 1000) throw new Error(`PDF too small: ${r.data.length} bytes`);
    });

    await test('Admin export blocks unauthenticated', async() => {
        const r = await fetch_req('GET', '/api/admin/export/full');
        if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
    });

    await test('Invalid JWT token rejected', async() => {
        const r = await fetch_req('GET', '/api/admin/export/full', null, 'invalid.token');
        if (r.status !== 401) throw new Error(`Expected 401, got ${r.status}`);
    });

    await test('Participant count calculated', async() => {
        const r = await fetch_req('GET', '/api/feedback?page=1&pageSize=100');
        if (r.data.stats.uniqueParticipants < 1) throw new Error('Count should be > 0');
    });

    console.log(`\n=== TEST SUMMARY ===`);
    console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
    if (failed === 0) {
        console.log('\n✓ ALL TESTS PASSED - SYSTEM READY FOR PRODUCTION');
        process.exit(0);
    } else {
        console.log('\n✗ Some tests failed');
        process.exit(1);
    }
}

run().catch(e => {
    console.error('Test runner error:', e);
    process.exit(1);
});