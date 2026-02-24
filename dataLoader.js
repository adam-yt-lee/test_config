// ============================================
// CSV-Based Data Loading (no XLSX dependency)
// Populates: products, filterCategories, configSectionDefs (globals in app.js)
// ============================================

// -----------------------------------------------
// CSV Parser — handles quoted fields, embedded newlines, escaped quotes
// -----------------------------------------------
function parseCSV(text) {
    const rows = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
        const row = [];
        while (true) {
            let field = '';
            if (i < n && text[i] === '"') {
                i++; // skip opening quote
                while (i < n) {
                    if (text[i] === '"') {
                        if (i + 1 < n && text[i + 1] === '"') { field += '"'; i += 2; }
                        else { i++; break; }
                    } else { field += text[i++]; }
                }
            } else {
                while (i < n && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
                    field += text[i++];
                }
                field = field.trim();
            }
            row.push(field);
            if (i < n && text[i] === ',') { i++; }
            else { if (i < n && text[i] === '\r') i++; if (i < n && text[i] === '\n') i++; break; }
        }
        if (row.length > 0 && !(row.length === 1 && row[0] === '')) rows.push(row);
    }
    return rows;
}

function csvRowsToObjects(rows) {
    if (rows.length < 2) return [];
    const headers = rows[0].map(h => h.trim());
    return rows.slice(1).map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = (row[i] !== undefined ? row[i] : '').trim(); });
        return obj;
    });
}

// -----------------------------------------------
// Normalize SSD form factor to standard categories
// -----------------------------------------------
function normalizeFormFactor(ff) {
    if (!ff) return '';
    const f = ff.trim().replace(/\n/g, ' ').toLowerCase();
    if (f.includes('22110') || f.includes('22x110')) return 'M.2-22110';
    if (f.includes('2280') || f.includes('22x80')) return 'M.2-2280';
    if (f.includes('e1.s')) return 'E1.S';
    if (f.includes('e3.s')) return 'E3.S';
    if (f.includes('15mm')) return 'U.2-15mm';
    if (f.includes('9.5mm') || f.includes('u.2') || f.includes('u.3') || f.includes('7mm')) return 'U.2-7mm';
    if (f.includes('3.5')) return 'HDD-3.5';
    if (f.includes('2.5')) return 'SSD-2.5';
    return ff.trim();
}

// -----------------------------------------------
// Slot / disk parsing helpers
// -----------------------------------------------
function parseSlotList(spec) {
    // "G5-FHFL-x16*2&G5-FHFL-x8*2|G5-FHFL-x16-dw*2"  → use first alternative
    if (!spec || spec === 'none') return [];
    const firstConfig = spec.split('|')[0].trim();
    const slots = [];
    firstConfig.split('&').forEach(part => {
        part = part.trim();
        const m = part.match(/^(.+?)\*(\d+)$/);
        if (m) { for (let j = 0; j < parseInt(m[2]); j++) slots.push(m[1].trim()); }
        else if (part) slots.push(part);
    });
    return slots;
}

function parseDiskSlotMap(spec) {
    // Union ALL alternatives so we know all supported types
    if (!spec || spec === 'none') return {};
    const result = {};
    spec.split('|').forEach(config => {
        config.trim().split('&').forEach(part => {
            part = part.trim();
            const m = part.match(/^(.+?)\*(\d+)$/);
            if (m) result[m[1].trim()] = parseInt(m[2]);
        });
    });
    return result;
}

function parseNodeSpecs(field, parseFn) {
    // Returns [{nodeId, data}]
    if (!field || field === 'none') return [{ nodeId: null, data: parseFn('') }];
    const lines = field.split('\n').map(l => l.trim()).filter(l => l);
    if (!lines.length) return [{ nodeId: null, data: parseFn('') }];
    const firstMatch = lines[0].match(/^([A-Z]):\s*(.*)$/);
    if (!firstMatch) return [{ nodeId: null, data: parseFn(field) }];
    const nodeMap = {};
    lines.forEach(line => {
        const m = line.match(/^([A-Z]):\s*(.*)$/);
        if (m) nodeMap[m[1]] = m[2];
    });
    return Object.entries(nodeMap).map(([nodeId, spec]) => ({ nodeId, data: parseFn(spec) }));
}

// -----------------------------------------------
// Product parsing
// -----------------------------------------------
function buildProduct(row) {
    const nodeCount = parseInt(row['nodeCount']) || 1;
    const cpuVendor = (row['cpuVendor'] || '').toLowerCase();

    // CpuPerNode: "xeon-6*2" or "xeon-5*2|xeon-4*2"
    const cpuRaw = (row['CpuPerNode'] || '').split('|')[0].trim();
    const cpuMatch = cpuRaw.match(/^(.+?)\*(\d+)$/);
    const cpuSeries = (cpuMatch ? cpuMatch[1] : cpuRaw).toLowerCase();
    const cpuSockets = cpuMatch ? parseInt(cpuMatch[2]) : 1;

    // DIMM: "DDR5*32"
    const dimmRaw = row['dimmPerNode'] || '';
    const dimmMatch = dimmRaw.match(/^(DDR\d+)\*(\d+)$/);
    const dimmType = dimmMatch ? dimmMatch[1] : 'DDR5';
    const dimmSlots = dimmMatch ? parseInt(dimmMatch[2]) : 0;

    // GPU
    const gpuTypeRaw = (row['gpuType'] || 'none');
    const gpuType = gpuTypeRaw.split('|').map(s => s.trim().toLowerCase());

    // Application
    const application = (row['application'] || '').split('|').map(s => s.trim().toLowerCase());

    // PCIe slots per node — may be multinode "A: ...\nB: ..."
    const pcieNodeSpecs = parseNodeSpecs(row['pcieSlotsPerNode'] || '', parseSlotList);
    const ocpSlots = parseSlotList(row['ocpslotspernode'] || '');

    // Disk slots
    const frontNodeSpecs = parseNodeSpecs(row['frontDiskSlotsPerNode'] || '', parseDiskSlotMap);
    const rearNodeSpecs  = parseNodeSpecs(row['rearDiskSlotsPerNode']  || '', parseDiskSlotMap);

    // M.2 (internal) — always common to all nodes
    const m2Map = parseDiskSlotMap(row['internalDiskSlotsPerNode'] || '');
    const m2MaxLength = Object.keys(m2Map).some(k => k.includes('22110')) ? '22110' : '2280';

    // Build nodes
    const isMultiNode = nodeCount > 1 && pcieNodeSpecs.length > 1;
    let nodes;
    if (isMultiNode) {
        const nodeIds = [...new Set(pcieNodeSpecs.map(n => n.nodeId))];
        nodes = nodeIds.map(nodeId => ({
            nodeId,
            defaultQty: nodeCount,
            pcieSlots: (pcieNodeSpecs.find(n => n.nodeId === nodeId) || { data: [] }).data,
            frontDiskSlots: (frontNodeSpecs.find(n => n.nodeId === nodeId) || { data: {} }).data,
            rearDiskSlots:  (rearNodeSpecs.find(n  => n.nodeId === nodeId) || { data: {} }).data,
        }));
    } else {
        nodes = [{
            nodeId: null,
            defaultQty: nodeCount,
            pcieSlots: pcieNodeSpecs[0] ? pcieNodeSpecs[0].data : [],
            frontDiskSlots: frontNodeSpecs[0] ? frontNodeSpecs[0].data : {},
            rearDiskSlots:  rearNodeSpecs[0]  ? rearNodeSpecs[0].data  : {},
        }];
    }

    return {
        id: row['id'] || '',
        platform: (row['platform'] || '').toLowerCase(),
        cooling: (row['cooling'] || '').toLowerCase(),
        formFactor: (row['formFactor'] || '').toLowerCase(),
        gpuType,
        gpus: parseInt(row['gpus']) || 0,
        application,
        nodeCount,
        nodeType: nodeCount > 1 ? 'multi' : 'single',
        cpuVendor,
        cpuSeries,
        cpuSockets,
        maxCpuTDP: parseInt(row['MaxCpuTDP(W)']) || 0,
        dimmType,
        dimmSlots,
        ocpSlots,
        m2Slots: m2Map,
        m2MaxLength,
        isMultiNode,
        nodes,
    };
}

// -----------------------------------------------
// Commodity parsers
// -----------------------------------------------
function parseCPURows(rows) {
    return rows.slice(1).filter(r => r[5]).map(r => ({
        id: r[5].trim(),
        name: `${r[0].trim()} ${r[4].trim()} ${r[5].trim()}`,
        desc: `${parseInt(r[6])||0}C/${parseInt(r[7])||0}T @ ${r[8]} GHz | ${r[4].trim()}`,
        brand: r[0].trim(), subGroup: r[4].trim(), pcieInterface: '',
        meta: { cores: parseInt(r[6])||0, threads: parseInt(r[7])||0, freq: parseFloat(r[8])||0 }
    }));
}

function parseDIMMRows(rows) {
    return rows.slice(1).filter(r => r[5]).map(r => ({
        id: r[5].trim(),
        name: `${r[0].trim()} ${r[4].trim()} ${r[6]}MT/s ${r[7]}GB`,
        desc: `${r[4].trim()} | ${r[6]} MT/s | ${r[7]} GB`,
        brand: r[0].trim(), subGroup: r[4].trim(), pcieInterface: '',
        meta: { freq: parseInt(r[6])||0, density: parseInt(r[7])||0 }
    }));
}

function parseGPURows(rows) {
    return rows.slice(1).filter(r => r[5]).map(r => {
        const subGroup = r[4].trim();
        const pcieInterface = (subGroup === 'PCIe' || subGroup === 'NVLink') ? 'PCIe-x16' : '';
        return {
            id: r[5].trim(),
            name: `${r[0].trim()} ${(r[6]||'').trim()}`,
            desc: `${r[0].trim()} | ${subGroup} | ${(r[6]||'').trim()}`,
            brand: r[0].trim(), subGroup, pcieInterface,
            meta: { spec: (r[6]||'').trim() }
        };
    });
}

function parseHDDRows(rows) {
    return rows.slice(1).filter(r => r[5]).map(r => ({
        id: r[5].trim(),
        name: `${r[0].trim()} ${r[6]}TB ${r[4].trim()} ${(r[7]||'').trim()}`,
        desc: `${r[4].trim()} | ${(r[7]||'').trim()} | ${r[6]} TB`,
        brand: r[0].trim(), subGroup: r[4].trim(), pcieInterface: '',
        meta: { density: r[6].toString().trim(), formFactor: (r[7]||'').trim(), interface: r[4].trim() }
    }));
}

function parseSSDRows(rows) {
    return rows.slice(1).filter(r => r[5]).map(r => {
        const iface = (r[6]||'').replace(/\n/g, ' ').trim();
        const ff    = (r[7]||'').replace(/\n/g, ' ').trim();
        const cap   = (r[8]||'').toString().trim();
        const ffNorm = normalizeFormFactor(ff);
        let m2Length = '';
        if (ffNorm === 'M.2-2280') m2Length = '2280';
        else if (ffNorm === 'M.2-22110') m2Length = '22110';
        return {
            id: r[5].trim(),
            name: `${r[0].trim()} ${r[4].trim()} ${cap} ${ff}`,
            desc: `${iface} | ${ff} | ${cap}`,
            brand: r[0].trim(), subGroup: r[4].trim(), pcieInterface: '',
            meta: {
                interface: iface, formFactor: ff, formFactorNorm: ffNorm, capacity: cap,
                isNVMe: iface.toLowerCase().includes('nvme'),
                isSATA: iface.toLowerCase().includes('sata'),
                isSAS: iface.toLowerCase().includes('sas'),
                isM2: ffNorm.startsWith('M.2'), m2Length
            }
        };
    });
}

function parseNICRows(rows) {
    return rows.slice(1).filter(r => r[5]).map(r => {
        const speed   = (r[4]||'').trim();
        const mpn     = r[5].trim();
        const ports   = parseInt(r[6]) || 1;
        const ff      = (r[7]||'').trim();
        const cable   = (r[9]||'').trim();
        const speedN  = parseInt(speed) || 0;
        const ffl     = ff.toLowerCase();

        let pcieInterface = 'PCIe-x8';
        if (ffl.includes('ocp3.0') || ffl.includes('ocp 3.0')) {
            pcieInterface = (ports >= 4 || speedN >= 100) ? 'OCP3.0-x16' : 'OCP3.0-x8';
        } else if (ffl.includes('ocp2.0')) {
            pcieInterface = 'OCP2.0';
        }

        let sfpType = '';
        if (cable.includes('SFP')) sfpType = 'SFP+';
        else if (speedN <= 10) sfpType = 'SFP+';
        else if (speedN === 25 || speedN === 32) sfpType = 'SFP28';
        else if (speedN >= 100) sfpType = 'QSFP28';

        return {
            id: mpn,
            name: `${r[0].trim()} ${mpn} ${speed}G ${ports}P`,
            desc: `${r[0].trim()} | ${speed}G | ${ports} port(s) | ${ff}`,
            brand: r[0].trim(), subGroup: speed, pcieInterface,
            meta: { speed: speedN, speedStr: speed, ports, formFactor: ff, sfpType, isOCP: ffl.includes('ocp') }
        };
    });
}

function parseRAIDHBARows(rows) {
    const sections = { HBA: [], Raid: [], 'M.2 Raid': [], BBU: [] };
    rows.slice(1).filter(r => r[1]).forEach(r => {
        const key = r[1].trim();
        if (!sections[key]) return;
        const mpn  = (r[5]||'').trim();
        const spec = (r[6]||'').trim();
        const portMatch = spec.match(/(\d+)i\b/);
        const internalPorts = portMatch ? parseInt(portMatch[1]) : 0;
        sections[key].push({
            id: mpn,
            name: `${r[0].trim()} ${spec}`,
            desc: key === 'M.2 Raid' ? `M.2 RAID card | ${spec}` :
                  key === 'BBU'      ? `Battery Backup Unit | ${spec}` :
                  `${spec} | ${internalPorts}i internal ports`,
            brand: r[0].trim(), subGroup: key, pcieInterface: 'PCIe-x8',
            meta: { spec, internalPorts, isM2Raid: key === 'M.2 Raid' }
        });
    });
    return sections;
}

function parseTransceiverRows(rows) {
    return rows.slice(1).filter(r => r[5]).map(r => {
        const speed = (r[4]||'').trim();
        const iface = (r[6]||'').trim();
        const mode  = (r[7]||'').trim();
        return {
            id: r[5].trim(),
            name: `${r[0].trim()} ${speed}G ${iface} ${mode}`.trim(),
            desc: `${speed}G | ${iface} | ${mode}`,
            brand: r[0].trim(), subGroup: speed, pcieInterface: '',
            meta: { speed: parseInt(speed)||0, interface: iface, mode }
        };
    });
}

// -----------------------------------------------
// Filters parsing
// -----------------------------------------------
function parseFiltersCSV(rows) {
    const map = new Map();
    rows.slice(1).forEach(r => {
        const key = r[0].trim();
        if (!map.has(key)) map.set(key, { key, name: r[1].trim(), options: [] });
        map.get(key).options.push({ value: r[2].trim(), label: r[3].trim() });
    });
    return Array.from(map.values());
}

// -----------------------------------------------
// Section def builder
// -----------------------------------------------
function buildSectionDefs(c) {
    return [
        { key: 'cpu',         name: 'CPU',              type: 'single',   dependsOn: null,   options: c.cpu },
        { key: 'dimm',        name: 'DIMM / Memory',    type: 'single',   dependsOn: null,   options: c.dimm },
        { key: 'gpu',         name: 'GPU / Accelerator', type: 'single',  dependsOn: null,   options: c.gpu },
        { key: 'hdd',         name: 'HDD',              type: 'optional', dependsOn: null,   options: c.hdd },
        { key: 'ssd',         name: 'SSD / NVMe',       type: 'optional', dependsOn: null,   options: c.ssd },
        { key: 'nic',         name: 'NIC Card',         type: 'multi',    dependsOn: null,   options: c.nic },
        { key: 'hba',         name: 'HBA Card',         type: 'optional', dependsOn: null,   options: c.hba },
        { key: 'raid',        name: 'RAID',             type: 'optional', dependsOn: 'disk', options: c.raid },
        { key: 'm2raid',      name: 'M.2 RAID',         type: 'optional', dependsOn: 'disk', options: c.m2raid },
        { key: 'bbu',         name: 'BBU (Backup)',     type: 'optional', dependsOn: 'raid', options: c.bbu },
        { key: 'transceiver', name: 'Transceiver',      type: 'optional', dependsOn: 'nic',  options: c.transceiver },
    ];
}

// -----------------------------------------------
// Main loader
// -----------------------------------------------
async function loadData(callback) {
    try {
        const fetches = await Promise.all([
            fetch('Products.csv').then(r => { if (!r.ok) throw new Error('Products.csv ' + r.status); return r.text(); }),
            fetch('Filters.csv').then(r => { if (!r.ok) throw new Error('Filters.csv ' + r.status); return r.text(); }),
            fetch('Commodities/Commodities_CPU.csv').then(r => r.text()),
            fetch('Commodities/Commodities_DIMM.csv').then(r => r.text()),
            fetch('Commodities/Commodities_GPU.csv').then(r => r.text()),
            fetch('Commodities/Commodities_HDD.csv').then(r => r.text()),
            fetch('Commodities/Commodities_SSD.csv').then(r => r.text()),
            fetch('Commodities/Commodities_NIC.csv').then(r => r.text()),
            fetch('Commodities/Commodities_RAID & HBA.csv').then(r => r.text()),
            fetch('Commodities/Commodities_Tranceiver.csv').then(r => r.text()),
        ]);
        const [prodText, filtText, cpuText, dimmText, gpuText, hddText, ssdText, nicText, raidText, transText] = fetches;

        products = csvRowsToObjects(parseCSV(prodText)).map(buildProduct).filter(p => p.id);
        filterCategories = parseFiltersCSV(parseCSV(filtText));

        const raidSec = parseRAIDHBARows(parseCSV(raidText));
        configSectionDefs = buildSectionDefs({
            cpu:         parseCPURows(parseCSV(cpuText)),
            dimm:        parseDIMMRows(parseCSV(dimmText)),
            gpu:         parseGPURows(parseCSV(gpuText)),
            hdd:         parseHDDRows(parseCSV(hddText)),
            ssd:         parseSSDRows(parseCSV(ssdText)),
            nic:         parseNICRows(parseCSV(nicText)),
            hba:         raidSec.HBA,
            raid:        raidSec.Raid,
            m2raid:      raidSec['M.2 Raid'],
            bbu:         raidSec.BBU,
            transceiver: parseTransceiverRows(parseCSV(transText)),
        });

        if (callback) callback();
    } catch (err) {
        console.error('loadData failed:', err);
        alert('Failed to load data: ' + err.message);
    }
}
