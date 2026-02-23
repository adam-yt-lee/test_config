// ============================================
// Data Loading & XLSX Parsing
// ============================================
// Depends on: SheetJS (XLSX global)
// Populates: products, filterCategories, configSectionDefs (globals in app.js)

function sheetToRows(workbook, sheetName) {
    const sheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

function parseProducts(rows) {
    return rows.map(row => ({
        id: String(row.id || ''),
        platform: String(row.platform || ''),
        cooling: String(row.cooling || ''),
        vendor: String(row.vendor || ''),
        cpuSeries: String(row.cpuSeries || ''),
        formFactor: String(row.formFactor || ''),
        gpuType: String(row.gpuType || ''),
        gpus: parseInt(row.gpus, 10) || 0,
        dimmSlots: parseInt(row.dimmSlots, 10) || 0,
        lanSpeed: String(row.lanSpeed || ''),
        application: row.application ? String(row.application).split('|') : [],
        pcieSlots: row.pcieSlots ? String(row.pcieSlots).split('|').map(s => s.trim()).filter(Boolean) : []
    }));
}

function parseFilters(rows) {
    const categoryMap = new Map();
    rows.forEach(row => {
        const key = String(row.category_key || '');
        if (!categoryMap.has(key)) {
            categoryMap.set(key, { key, name: String(row.category_name || ''), options: [] });
        }
        categoryMap.get(key).options.push({
            value: String(row.option_value || ''),
            label: String(row.option_label || '')
        });
    });
    return Array.from(categoryMap.values());
}

function parseConfigOptions(rows) {
    const sectionMap = new Map();
    rows.forEach(row => {
        const key = String(row.section_key || '');
        if (!key) return;
        if (!sectionMap.has(key)) {
            sectionMap.set(key, {
                key,
                name: String(row.section_name || ''),
                type: String(row.section_type || 'single'),
                options: []
            });
        }
        sectionMap.get(key).options.push({
            id: String(row.option_id || ''),
            name: String(row.option_name || ''),
            desc: String(row.option_desc || ''),
            defaultQty: parseInt(row.default_qty) || 1,
            qtyEditable: String(row.qty_editable).toLowerCase() === 'true',
            appliesTo: String(row.applies_to || '*'),
            pcieInterface: String(row.pcie_interface || '')
        });
    });
    return Array.from(sectionMap.values());
}

async function loadData(callback) {
    try {
        const resp = await fetch('data.xlsx');
        if (!resp.ok) throw new Error(`Failed to fetch data.xlsx: ${resp.status}`);
        const workbook = XLSX.read(await resp.arrayBuffer(), { type: 'array' });
        products = parseProducts(sheetToRows(workbook, 'Products'));
        filterCategories = parseFilters(sheetToRows(workbook, 'Filters'));
        configSectionDefs = parseConfigOptions(sheetToRows(workbook, 'ConfigOptions'));
        if (callback) callback();
    } catch (err) {
        console.error('loadData failed:', err);
        alert('Failed to load configuration data. Please refresh the page.');
    }
}
