// Test script for Vietnamese diacritics handling
// This tests the improved search mechanism

function removeDiacritics(str) {
    return String(str || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function normalizeValue(value) {
    return removeDiacritics(String(value || "").trim()).toLowerCase();
}

function normalizeUnits(units) {
    const unique = new Set();
    for (const item of units) {
        const unit = String(item || "").trim().replace(/\s+/g, "");
        if (!unit) {
            continue;
        }
        unique.add(unit);
    }
    return Array.from(unique);
}

// Test cases
console.log("=== DIACRITICS REMOVAL TESTS ===\n");

// Test 1: Vietnamese names with diacritics
const testNames = [
    { input: "Nguyễn Văn A", expected: "nguyen van a" },
    { input: "NGUYỄN VĂN A", expected: "nguyen van a" },
    { input: "Trần Phúc", expected: "tran phuc" },
    { input: "Lê Hồng Phong", expected: "le hong phong" },
    { input: "Phạm Thị Hương", expected: "pham thi huong" },
];

console.log("Test 1: Names with diacritics");
testNames.forEach(({ input, expected }) => {
    const result = normalizeValue(input);
    const pass = result === expected;
    console.log(`  ${pass ? "✓" : "✗"} "${input}" -> "${result}" (expected: "${expected}")`);
});

console.log("\n=== UNIT CODE WHITESPACE TESTS ===\n");

// Test 2: Unit codes with various whitespace
const testUnits = [
    { input: ["101A", "102B"], expected: ["101a", "102b"] },
    { input: ["101 A", "102 B"], expected: ["101a", "102b"] },
    { input: ["101  A", "102   B"], expected: ["101a", "102b"] },
    { input: ["A1 0 1"], expected: ["a101"] },
    { input: ["101A", "101 A", "101  A"], expected: ["101a"] }, // Deduplication
];

console.log("Test 2: Unit codes with whitespace");
testUnits.forEach(({ input, expected }) => {
    const result = normalizeUnits(input).map(u => normalizeValue(u)).sort();
    const expSorted = expected.sort();
    const pass = JSON.stringify(result) === JSON.stringify(expSorted);
    console.log(`  ${pass ? "✓" : "✗"} ${JSON.stringify(input)} -> ${JSON.stringify(result)} (expected: ${JSON.stringify(expSorted)})`);
});

console.log("\n=== SEARCH MATCHING TESTS ===\n");

// Test 3: Search matching with diacritics
function matchesSearch(searchTerm, targetText) {
    if (!searchTerm) return true;
    return normalizeValue(targetText).includes(normalizeValue(searchTerm));
}

const searchTests = [
    { search: "Nguyễn", text: "Nguyễn Văn A", expected: true },
    { search: "nguyen", text: "Nguyễn Văn A", expected: true },
    { search: "NGUYỄN", text: "Nguyễn Văn A", expected: true },
    { search: "van", text: "Nguyễn Văn A", expected: true },
    { search: "VĂN", text: "Nguyễn Văn A", expected: true },
    { search: "xyz", text: "Nguyễn Văn A", expected: false },
];

console.log("Test 3: Search matching");
searchTests.forEach(({ search, text, expected }) => {
    const result = matchesSearch(search, text);
    const pass = result === expected;
    console.log(`  ${pass ? "✓" : "✗"} search("${search}", "${text}") = ${result} (expected: ${expected})`);
});

console.log("\n=== UNIT CODE MATCHING TESTS ===\n");

// Test 4: Unit code matching (at least one must match)
function hasMatchingUnit(providedUnits, targetUnits) {
    const providedSet = new Set(
        normalizeUnits(providedUnits).map(u => normalizeValue(u))
    );
    return targetUnits.some(u => providedSet.has(normalizeValue(u)));
}

const unitTests = [
    { provided: ["101A"], target: ["101A"], expected: true },
    { provided: ["101 A"], target: ["101A"], expected: true },
    { provided: ["101A", "102B"], target: ["101A"], expected: true },
    { provided: ["101A"], target: ["101A", "102B"], expected: true },
    { provided: ["103"], target: ["101A", "102B"], expected: false },
];

console.log("Test 4: Unit code matching");
unitTests.forEach(({ provided, target, expected }) => {
    const result = hasMatchingUnit(provided, target);
    const pass = result === expected;
    console.log(`  ${pass ? "✓" : "✗"} provided: ${JSON.stringify(provided)}, target: ${JSON.stringify(target)} = ${result} (expected: ${expected})`);
});

console.log("\n=== SUMMARY ===");
console.log("All core search functions have been tested.");
console.log("The search mechanism now supports:");
console.log("  • Case-insensitive name search");
console.log("  • Diacritic-insensitive name search");
console.log("  • Unit codes with whitespace handling");
console.log("  • Unit code matching (any 1 code must match)");