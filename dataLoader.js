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
    // M.2: classic (22110, 2280) and consolidated notation (M.2/110, M.2/80)
    if (f.includes('22110') || f.includes('22x110') || /m\.2[\/]?110/.test(f)) return 'M.2-22110';
    if (f.includes('2280') || f.includes('22x80') || /m\.2[\/]?80/.test(f)) return 'M.2-2280';
    if (f.includes('e1.s')) return 'E1.S';
    if (f.includes('e3.s')) return 'E3.S';
    // 15mm thickness: handles '15mm', '2.5"/15', 'U.3/15', etc.
    if (f.includes('15mm') || /[\/\-]15$/.test(f) || /[\/\-]15\b/.test(f)) return 'U.2-15mm';
    // 7mm / 9.5mm / U.2 / U.3 variants — also catches "2.5"/7" and "2.5"/9.5" catalog notation
    if (f.includes('9.5mm') || f.includes('u.2') || f.includes('u.3') || f.includes('7mm') ||
        /[\/]7$/.test(f) || /[\/]9\.?5$/.test(f)) return 'U.2-7mm';
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

function parseSlotSchemes(spec) {
    // Returns array of scheme objects: [{label, slots:[]}]
    // "|" separates alternative schemes, "&" joins slots within a scheme
    if (!spec || spec === 'none') return [{ label: '', slots: [] }];
    return spec.split('|').map(config => {
        config = config.trim();
        const slots = [];
        config.split('&').forEach(part => {
            part = part.trim();
            const m = part.match(/^(.+?)\*(\d+)$/);
            if (m) { for (let j = 0; j < parseInt(m[2]); j++) slots.push(m[1].trim()); }
            else if (part) slots.push(part);
        });
        return { label: config, slots };
    });
}

function parseDiskSchemes(spec) {
    // Returns array of scheme objects: [{label, map:{slotType:count}}]
    // "|" separates alternative schemes
    if (!spec || spec === 'none') return [{ label: '', map: {} }];
    return spec.split('|').map(config => {
        config = config.trim();
        const map = {};
        config.split('&').forEach(part => {
            part = part.trim();
            const m = part.match(/^(.+?)\*(\d+)$/);
            if (m) map[m[1].trim()] = parseInt(m[2]);
            else if (part) map[part] = 1;
        });
        return { label: config, map };
    });
}

function mergeDiskSchemes(schemes) {
    // Union all disk scheme maps into one
    const result = {};
    schemes.forEach(s => { for (const [k, v] of Object.entries(s.map || s)) result[k] = v; });
    return result;
}

function parseDiskSlotMap(spec) {
    // Union ALL alternatives so we know all supported types (backward compat)
    if (!spec || spec === 'none') return {};
    return mergeDiskSchemes(parseDiskSchemes(spec));
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
    const pcieNodeSpecs = parseNodeSpecs(row['pcieSlotsPerNode'] || '', parseSlotSchemes);
    const ocpSlots = parseSlotList(row['ocpslotspernode'] || '');

    // Disk slots
    const frontNodeSpecs = parseNodeSpecs(row['frontDiskSlotsPerNode'] || '', parseDiskSchemes);
    const rearNodeSpecs  = parseNodeSpecs(row['rearDiskSlotsPerNode']  || '', parseDiskSchemes);

    // M.2 (internal) — always common to all nodes
    const m2Map = parseDiskSlotMap(row['internalDiskSlotsPerNode'] || '');
    const m2MaxLength = Object.keys(m2Map).some(k => k.includes('22110')) ? '22110' : '2280';

    // Build nodes
    const isMultiNode = nodeCount > 1 && pcieNodeSpecs.length > 1;
    let nodes;
    if (isMultiNode) {
        const nodeIds = [...new Set(pcieNodeSpecs.map(n => n.nodeId))];
        const defaultQtyPerType = Math.floor(nodeCount / nodeIds.length) || 1;
        nodes = nodeIds.map(nodeId => {
            const pcieSchemes  = (pcieNodeSpecs.find(n => n.nodeId === nodeId) || { data: [{ label: '', slots: [] }] }).data;
            const frontSchemes = (frontNodeSpecs.find(n => n.nodeId === nodeId) || { data: [{ label: '', map: {} }] }).data;
            const rearSchemes  = (rearNodeSpecs.find(n  => n.nodeId === nodeId) || { data: [{ label: '', map: {} }] }).data;
            return {
                nodeId,
                defaultQty: defaultQtyPerType,
                pcieSlotSchemes: pcieSchemes,
                pcieSlots: pcieSchemes[0] ? pcieSchemes[0].slots : [],
                frontDiskSchemes: frontSchemes,
                frontDiskSlots: mergeDiskSchemes(frontSchemes),
                rearDiskSchemes: rearSchemes,
                rearDiskSlots: mergeDiskSchemes(rearSchemes),
            };
        });
    } else {
        const pcieSchemes  = pcieNodeSpecs[0] ? pcieNodeSpecs[0].data : [{ label: '', slots: [] }];
        const frontSchemes = frontNodeSpecs[0] ? frontNodeSpecs[0].data : [{ label: '', map: {} }];
        const rearSchemes  = rearNodeSpecs[0]  ? rearNodeSpecs[0].data  : [{ label: '', map: {} }];
        nodes = [{
            nodeId: null,
            defaultQty: nodeCount,
            pcieSlotSchemes: pcieSchemes,
            pcieSlots: pcieSchemes[0] ? pcieSchemes[0].slots : [],
            frontDiskSchemes: frontSchemes,
            frontDiskSlots: mergeDiskSchemes(frontSchemes),
            rearDiskSchemes: rearSchemes,
            rearDiskSlots: mergeDiskSchemes(rearSchemes),
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
// Consolidated CSV parser — single file replaces all individual commodity CSVs
// Columns: section_key, section_name, section type, Brand, Sub.Group, MPN,
//          Option name, Cores, Threads, Freq(GHz), MaxMemSpeed(MT/s), SRAM_Cache(MB),
//          DRAM_Cache(GB), BBU, Freq(MT/s), Capacity(GB), FormFactor(/mm), Interface,
//          HDD_RPM, PCIeVersion, PCIeLane, Spec, Port, Connector, XCVR_Mode
// -----------------------------------------------
function parseConsolidatedCSV(rows) {
    const empty = { cpu:[], dimm:[], gpu:[], hdd:[], ssd:[], nic:[], hba:[], raid:[], m2raid:[], bbu:[], transceiver:[] };
    if (rows.length < 2) return empty;

    const headers = rows[0].map(h => h.trim());
    const ci = name => headers.indexOf(name);

    const IDX = {
        skey:      ci('section_key'),
        brand:     ci('Brand'),
        subGroup:  ci('Sub.Group'),
        mpn:       ci('MPN'),
        optName:   ci('Option name'),
        cores:     ci('Cores'),
        threads:   ci('Threads'),
        freqGHz:   ci('Freq(GHz)'),
        maxMem:    ci('MaxMemSpeed(MT/s)'),
        sramCache: ci('SRAM_Cache(MB)'),
        bbuCol:    ci('BBU'),
        freqMTs:   ci('Freq(MT/s)'),
        capacity:  ci('Capacity(GB)'),
        ff:        ci('FormFactor(/mm)'),
        iface:     ci('Interface'),
        hddRpm:    ci('HDD_RPM'),
        pcieVer:   ci('PCIeVersion'),
        pcieLane:  ci('PCIeLane'),
        spec:      ci('Spec'),
        port:      ci('Port'),
        connector: ci('Connector'),
        xcvrMode:  ci('XCVR_Mode'),
    };

    const g = (r, idx) => idx >= 0 ? (r[idx] || '').trim() : '';

    const out = { cpu:[], dimm:[], gpu:[], hdd:[], ssd:[], nic:[], hba:[], raid:[], m2raid:[], bbu:[], transceiver:[] };

    rows.slice(1).forEach(r => {
        const mpn = g(r, IDX.mpn);
        if (!mpn) return;

        const skey    = g(r, IDX.skey).toLowerCase();
        const brand   = g(r, IDX.brand);
        const subGrp  = g(r, IDX.subGroup);
        const optName = g(r, IDX.optName);

        switch (skey) {
            case 'cpu': {
                const cores     = parseInt(g(r, IDX.cores))     || 0;
                const threads   = parseInt(g(r, IDX.threads))   || 0;
                const freq      = parseFloat(g(r, IDX.freqGHz)) || 0;
                const maxMem    = parseInt(g(r, IDX.maxMem))    || 0;
                const sramCache = parseFloat(g(r, IDX.sramCache)) || 0;
                out.cpu.push({
                    id: mpn, brand, subGroup: subGrp, pcieInterface: '',
                    name: optName || `${brand} ${subGrp} ${mpn}`,
                    desc: `${cores}C/${threads}T @ ${freq}GHz | ${subGrp}` +
                          (maxMem    ? ` | Mem: ${maxMem} MT/s`    : '') +
                          (sramCache ? ` | Cache: ${sramCache} MB` : ''),
                    meta: { cores, threads, freq, maxMemSpeed: maxMem, sramCache },
                });
                break;
            }
            case 'rdimm': {
                const freq    = parseInt(g(r, IDX.freqMTs))  || 0;
                const density = parseInt(g(r, IDX.capacity)) || 0;
                out.dimm.push({
                    id: mpn, brand, subGroup: 'DDR5', pcieInterface: '',
                    name: optName || `${brand} DDR5 ${freq}MT/s ${density}GB`,
                    desc: `DDR5 | ${freq} MT/s | ${density} GB`,
                    meta: { freq, density },
                });
                break;
            }
            case 'hdd': {
                const capGB = parseInt(g(r, IDX.capacity)) || 0;
                const capTB = capGB / 1000;
                const ff    = g(r, IDX.ff);
                const iface = g(r, IDX.iface);
                const rpm   = parseInt(g(r, IDX.hddRpm)) || 0;
                out.hdd.push({
                    id: mpn, brand, subGroup: subGrp, pcieInterface: '',
                    name: optName || `${brand} ${capTB}TB ${subGrp} ${ff}`,
                    desc: `${iface} | ${ff} | ${capTB} TB` + (rpm ? ` | ${rpm} RPM` : ''),
                    meta: { density: capTB.toString(), formFactor: ff, interface: iface,
                            isSAS: iface.toUpperCase() === 'SAS', rpm },
                });
                break;
            }
            case 'ssd': {
                const cap     = g(r, IDX.capacity);
                const ff      = g(r, IDX.ff);
                const iface   = g(r, IDX.iface);
                const pcieVer = g(r, IDX.pcieVer);
                const lane    = g(r, IDX.pcieLane);
                const ffNorm  = normalizeFormFactor(ff);
                let m2Length  = '';
                if (ffNorm === 'M.2-2280')  m2Length = '2280';
                if (ffNorm === 'M.2-22110') m2Length = '22110';
                const ifaceDesc = pcieVer ? `${iface} ${pcieVer} x${lane}` : iface;
                out.ssd.push({
                    id: mpn, brand, subGroup: subGrp, pcieInterface: '',
                    name: optName || `${brand} ${subGrp} ${cap}GB ${ff}`,
                    desc: `${ifaceDesc} | ${ff} | ${cap} GB`,
                    meta: {
                        interface: iface, formFactor: ff, formFactorNorm: ffNorm, capacity: cap,
                        isNVMe: iface.toLowerCase().includes('nvme'),
                        isSATA: iface.toLowerCase().includes('sata'),
                        isSAS:  iface.toLowerCase().includes('sas'),
                        isM2: ffNorm.startsWith('M.2'), m2Length,
                        pcieVersion: pcieVer, pcieLane: lane,
                    },
                });
                break;
            }
            case 'gpu': {
                const ff      = g(r, IDX.ff);
                const pcieVer = g(r, IDX.pcieVer);
                const lane    = g(r, IDX.pcieLane);
                const sgl     = subGrp.toLowerCase();
                // PCIe-based GPUs occupy a PCIe x16 slot; NVLink bridges, HGX and UBB boards do not
                const pcieInterface = (sgl === 'pcie' || sgl === 'pcie-ac' || sgl === 'pcie-lc') ? 'PCIe-x16' : '';
                out.gpu.push({
                    id: mpn, brand, subGroup: subGrp, pcieInterface,
                    name: optName || `${brand} ${mpn}`,
                    desc: `${brand} | ${subGrp}` +
                          (ff      ? ` | ${ff}`                       : '') +
                          (pcieVer ? ` | ${pcieVer} x${lane}`         : ''),
                    meta: { spec: optName, formFactor: ff, pcieVersion: pcieVer, pcieLane: lane },
                });
                break;
            }
            case 'hba': {
                const ff      = g(r, IDX.ff);
                const pcieVer = g(r, IDX.pcieVer);
                const lane    = g(r, IDX.pcieLane);
                const spec    = g(r, IDX.spec);
                const conn    = g(r, IDX.connector);
                const portMatch     = spec.match(/(\d+)i\b/);
                const internalPorts = portMatch ? parseInt(portMatch[1]) : 0;
                const pcieInterface = lane === '16' ? 'PCIe-x16' : 'PCIe-x8';
                out.hba.push({
                    id: mpn, brand, subGroup: subGrp, pcieInterface,
                    name: optName || `${brand} ${spec}`,
                    desc: spec +
                          (internalPorts ? ` | ${internalPorts}i ports`   : '') +
                          (pcieVer       ? ` | ${pcieVer} x${lane}`        : '') +
                          (conn          ? ` | ${conn}`                     : ''),
                    meta: { spec, internalPorts, isM2Raid: false,
                            formFactor: ff, pcieVersion: pcieVer, pcieLane: lane, connector: conn },
                });
                break;
            }
            case 'raid': {
                const ff        = g(r, IDX.ff);
                const pcieVer   = g(r, IDX.pcieVer);
                const lane      = g(r, IDX.pcieLane);
                const spec      = g(r, IDX.spec);
                const conn      = g(r, IDX.connector);
                const compatBBU = g(r, IDX.bbuCol);
                const isM2Raid  = subGrp.toUpperCase() === 'M2';
                const portMatch     = spec.match(/(\d+)i\b/);
                const internalPorts = portMatch ? parseInt(portMatch[1]) : 0;
                const pcieInterface = lane === '16' ? 'PCIe-x16' : 'PCIe-x8';
                const item = {
                    id: mpn, brand, subGroup: subGrp, pcieInterface,
                    name: optName || `${brand} ${spec}`,
                    desc: (isM2Raid ? 'M.2 RAID card' : spec) +
                          (internalPorts           ? ` | ${internalPorts}i ports`   : '') +
                          (pcieVer                 ? ` | ${pcieVer} x${lane}`        : '') +
                          (compatBBU && compatBBU !== 'N/A' ? ` | BBU: ${compatBBU}` : '') +
                          (conn                    ? ` | ${conn}`                     : ''),
                    meta: { spec, internalPorts, isM2Raid,
                            formFactor: ff, pcieVersion: pcieVer, pcieLane: lane, connector: conn },
                };
                if (isM2Raid) out.m2raid.push(item);
                else          out.raid.push(item);
                break;
            }
            case 'bbu': {
                const spec = g(r, IDX.spec);
                out.bbu.push({
                    id: mpn, brand, subGroup: subGrp, pcieInterface: '',
                    name: optName || `${brand} ${spec}`,
                    desc: `Battery Backup Unit | ${spec}`,
                    meta: { spec, internalPorts: 0, isM2Raid: false },
                });
                break;
            }
            case 'nic card': {
                const ff      = g(r, IDX.ff);
                const pcieVer = g(r, IDX.pcieVer);
                const lane    = g(r, IDX.pcieLane);
                const ports   = parseInt(g(r, IDX.port)) || 1;
                const conn    = g(r, IDX.connector);
                const speedN  = parseInt(subGrp) || 0;
                const ffl     = ff.toLowerCase();
                let pcieInterface = lane === '16' ? 'PCIe-x16' : 'PCIe-x8';
                if (ffl.includes('ocp3.0') || ffl.includes('ocp 3.0')) {
                    pcieInterface = (ports >= 4 || speedN >= 100) ? 'OCP3.0-x16' : 'OCP3.0-x8';
                } else if (ffl.includes('ocp2.0')) {
                    pcieInterface = 'OCP2.0';
                }
                out.nic.push({
                    id: mpn, brand, subGroup: subGrp, pcieInterface,
                    name: optName || `${brand} ${mpn} ${subGrp}G ${ports}P`,
                    desc: `${brand} | ${subGrp}G | ${ports} port(s) | ${ff}` + (conn ? ` | ${conn}` : ''),
                    meta: { speed: speedN, speedStr: subGrp, ports, formFactor: ff,
                            sfpType: conn, isOCP: ffl.includes('ocp'),
                            pcieVersion: pcieVer, pcieLane: lane },
                });
                break;
            }
            case 'transceiver': {
                const conn     = g(r, IDX.connector);
                const xcvrMode = g(r, IDX.xcvrMode);
                const speedN   = parseInt(subGrp) || 0;
                out.transceiver.push({
                    id: mpn, brand, subGroup: subGrp, pcieInterface: '',
                    name: optName || `${brand} ${subGrp}G ${conn} ${xcvrMode}`.trim(),
                    desc: `${subGrp}G | ${conn} | ${xcvrMode}`,
                    meta: { speed: speedN, interface: conn, mode: xcvrMode },
                });
                break;
            }
        }
    });

    return out;
}

// -----------------------------------------------
// SpecMapping CSV parser
// Columns: commodity_type, product_spec, commodity_subgroup
// Returns Map: commodity_type → { product_spec → [subgroup, ...] }
// -----------------------------------------------
function parseSpecMappingCSV(rows) {
    const map = {};
    rows.slice(1).forEach(r => {
        const type  = (r[0] || '').trim().toLowerCase();
        const spec  = (r[1] || '').trim().toLowerCase();
        const subGp = (r[2] || '').trim();
        if (!type || !spec || !subGp) return;
        if (!map[type])       map[type] = {};
        if (!map[type][spec]) map[type][spec] = [];
        map[type][spec].push(subGp);
    });
    return map;
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
// Cached fetch — uses sessionStorage to avoid re-downloading CSVs on navigation
// -----------------------------------------------
async function cachedFetch(url) {
    const key = 'csvCache_' + url;
    const cached = sessionStorage.getItem(key);
    if (cached) return cached;
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + ' ' + r.status);
    const text = await r.text();
    try { sessionStorage.setItem(key, text); } catch (e) { /* quota exceeded — ignore */ }
    return text;
}

// -----------------------------------------------
// Main loader — uses consolidated commodity file
// -----------------------------------------------
async function loadData(callback) {
    try {
        const [prodText, filtText, commText, mapText] = await Promise.all([
            cachedFetch('Products.csv'),
            cachedFetch('Filters.csv'),
            cachedFetch('Consolidated_Commodities_20260303.csv'),
            cachedFetch('SpecMapping.csv'),
        ]);

        products          = csvRowsToObjects(parseCSV(prodText)).map(buildProduct).filter(p => p.id);
        filterCategories  = parseFiltersCSV(parseCSV(filtText));
        configSectionDefs = buildSectionDefs(parseConsolidatedCSV(parseCSV(commText)));
        specMapping       = parseSpecMappingCSV(parseCSV(mapText));

        if (callback) callback();
    } catch (err) {
        console.error('loadData failed:', err);
        alert('Failed to load data: ' + err.message);
    }
}
