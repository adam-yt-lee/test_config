// ============================================
// PCIe Slot Compatibility Engine
// ============================================

// Which card interfaces each slot type accepts
const SLOT_ACCEPTS = {
    // Gen 5 Full-Height Full-Length
    'G5-FHFL-x16-dw': ['PCIe-x16-dw', 'PCIe-x16', 'PCIe-x8'],
    'G5-FHFL-x16':    ['PCIe-x16', 'PCIe-x8'],
    'G5-FHFL-x8':     ['PCIe-x8'],
    // Gen 5 Full-Height Half-Length
    'G5-FHHL-x16':    ['PCIe-x16', 'PCIe-x8'],
    'G5-FHHL-x8':     ['PCIe-x8'],
    // Gen 5 Half-Height Half-Length
    'G5-HHHL-x16':    ['PCIe-x16', 'PCIe-x8'],
    'G5-HHHL-x8':     ['PCIe-x8'],
    // Gen 4 Full-Height Full-Length
    'G4-FHFL-x16-dw': ['PCIe-x16-dw', 'PCIe-x16', 'PCIe-x8'],
    'G4-FHFL-x16':    ['PCIe-x16', 'PCIe-x8'],
    'G4-FHFL-x8':     ['PCIe-x8'],
    // Gen 4 Full-Height Half-Length / Half-Height
    'G4-FHHL-x16':    ['PCIe-x16', 'PCIe-x8'],
    'G4-FHHL-x8':     ['PCIe-x8'],
    'G4-HHHL-x8':     ['PCIe-x8'],
    // OCP slots
    'OCP3.0-SFF-x16': ['OCP3.0-x16', 'OCP3.0-x8'],
    'OCP3.0-SFF-x8':  ['OCP3.0-x8'],
    'OCP3.0-TFF-x8':  ['OCP3.0-x8'],
    'OCP2.0-A':        ['OCP2.0'],
};

// Assign most-constrained cards first
const INTERFACE_PRIORITY = {
    'PCIe-x16-dw': 0,
    'OCP3.0-x16':  1,
    'OCP3.0-x8':   2,
    'OCP2.0':      3,
    'PCIe-x16':    4,
    'PCIe-x8':     5,
};

// Prefer smallest compatible slot
const SLOT_SIZE = {
    'OCP3.0-SFF-x8':  0,
    'OCP3.0-TFF-x8':  1,
    'OCP2.0-A':        2,
    'OCP3.0-SFF-x16': 3,
    'G4-HHHL-x8':     4,
    'G5-HHHL-x8':     4,
    'G4-FHHL-x8':     5,
    'G5-FHHL-x8':     5,
    'G4-FHFL-x8':     6,
    'G5-FHFL-x8':     6,
    'G4-HHHL-x16':    7,
    'G5-HHHL-x16':    7,
    'G4-FHHL-x16':    8,
    'G5-FHHL-x16':    8,
    'G4-FHFL-x16':    9,
    'G5-FHFL-x16':    9,
    'G4-FHFL-x16-dw': 10,
    'G5-FHFL-x16-dw': 10,
};

// -----------------------------------------------
// Build card list from all sections in a node config
// -----------------------------------------------
function buildCardRequests(product, nodeSpec, sections) {
    const cardRequests = [];
    sections.forEach(section => {
        for (const [optId, qty] of Object.entries(section.selections)) {
            const opt = section.options.find(o => o.id === optId);
            if (!opt || !opt.pcieInterface) continue;
            for (let i = 0; i < qty; i++) {
                cardRequests.push({ sectionKey: section.key, optionId: optId, name: opt.name, iface: opt.pcieInterface });
            }
        }
    });

    // 1U chassis: RAID card needs extra PCIe x8 slot for BBU
    const is1U = (product.formFactor || '').includes('1ru');
    const hasRaid = sections.some(s => s.key === 'raid' && Object.keys(s.selections).length > 0);
    if (is1U && hasRaid) {
        cardRequests.push({ sectionKey: 'raid', optionId: '_bbu', name: 'RAID BBU (1U)', iface: 'PCIe-x8' });
    }

    return cardRequests;
}

// -----------------------------------------------
// Main slot validator
// activePcieSchemeIdx: -1 = no user selection → try all schemes, use best fit
// -----------------------------------------------
function validatePcieSlots(product, nodeSpec, sections, activePcieSchemeIdx = -1) {
    const ocpSlots = [...(product.ocpSlots || [])];

    const cardRequests = buildCardRequests(product, nodeSpec, sections);
    const sortedCards  = [...cardRequests].sort((a, b) =>
        (INTERFACE_PRIORITY[a.iface] ?? 99) - (INTERFACE_PRIORITY[b.iface] ?? 99)
    );

    // Rule: 2U NVMe 24 drives → G4-FHFL-x16 loses 2 slots (NVMe backplane)
    function applyNvme24Rule(slots) {
        if (product.formFactor !== '2ru' || _countNvme(sections) < 24) return slots;
        let removed = 0;
        return slots.filter(s => {
            if (s === 'G4-FHFL-x16' && removed < 2) { removed++; return false; }
            return true;
        });
    }

    function runAssignment(rawSlots) {
        const allSlotTypes = [...applyNvme24Rule([...rawSlots]), ...ocpSlots];
        const slots = allSlotTypes.map((type, idx) => ({ index: idx, type, assigned: null }));
        const assignments = [];
        const unassigned  = [];
        for (const card of sortedCards) {
            const compatSlots = slots
                .filter(s => !s.assigned && SLOT_ACCEPTS[s.type] && SLOT_ACCEPTS[s.type].includes(card.iface))
                .sort((a, b) => (SLOT_SIZE[a.type] ?? 99) - (SLOT_SIZE[b.type] ?? 99));
            if (compatSlots.length > 0) {
                const slot = compatSlots[0];
                slot.assigned = card;
                assignments.push({ slot, card });
            } else {
                unassigned.push(card);
            }
        }
        return { assignments, unassigned, slotStatus: slots,
                 totalCards: cardRequests.length, totalSlots: slots.length };
    }

    // Determine which slots to use
    const schemes = nodeSpec ? nodeSpec.pcieSlotSchemes : null;
    let result;
    if (schemes && schemes.length > 1 && activePcieSchemeIdx < 0) {
        // No user selection: try every scheme, keep the one with fewest conflicts
        let best = null;
        for (const scheme of schemes) {
            const r = runAssignment(scheme.slots);
            if (!best || r.unassigned.length < best.unassigned.length) {
                best = r;
                if (best.unassigned.length === 0) break; // can't do better
            }
        }
        result = best;
    } else {
        // Specific scheme selected by user, or single scheme
        let pcieSlots;
        if (schemes && activePcieSchemeIdx >= 0 && schemes[activePcieSchemeIdx]) {
            pcieSlots = schemes[activePcieSchemeIdx].slots;
        } else {
            pcieSlots = nodeSpec ? nodeSpec.pcieSlots
                       : (product.nodes && product.nodes[0] ? product.nodes[0].pcieSlots : []);
        }
        result = runAssignment(pcieSlots);
    }

    // Append slot-count warning and non-PCIe SAS warning
    const warnings = [];
    if (result.unassigned.length > 0) {
        warnings.push(`Not enough compatible PCIe slots for: ${result.unassigned.map(c => c.name).join(', ')}`);
    }
    const sasDrives = _getSASCount(sections);
    const hasRaidOrHBA = sections.some(s => (s.key === 'raid' || s.key === 'hba') && Object.keys(s.selections).length > 0);
    if (sasDrives > 0 && !hasRaidOrHBA) {
        warnings.push(`SAS drives require a RAID card or HBA card to be selected.`);
    }

    return { ...result, warnings };
}

function _countNvme(sections) {
    let count = 0;
    sections.forEach(s => {
        if (s.key !== 'ssd') return;
        for (const [optId, qty] of Object.entries(s.selections)) {
            const opt = s.options.find(o => o.id === optId);
            if (opt && opt.meta && opt.meta.isNVMe) count += qty;
        }
    });
    return count;
}

function _getSASCount(sections) {
    let count = 0;
    ['hdd', 'ssd'].forEach(key => {
        const sec = sections.find(s => s.key === key);
        if (!sec) return;
        for (const [optId, qty] of Object.entries(sec.selections)) {
            const opt = sec.options.find(o => o.id === optId);
            if (opt && opt.meta && opt.meta.isSAS) count += qty;
        }
    });
    return count;
}

// -----------------------------------------------
// Disk slot count conflict checker
// -----------------------------------------------
// Count how many slots in slotMap are compatible with a disk's form factor
function _countCompatibleSlots(slotMap, ff) {
    const f = (ff || '').toLowerCase();
    function matches(slotKey) {
        const sk = slotKey.toLowerCase();
        if (f.includes('3.5')) return sk.includes('3.5');
        // 2.5" / U.2 / U.3 can fit in both 2.5" and 3.5" bays (adapter rule)
        if (f.includes('2.5') || f.includes('u.2') || f.includes('u.3'))
            return sk.includes('2.5') || sk.includes('u.2') || sk.includes('u.3') || sk.includes('3.5');
        // EDSFF (E1.S / E3.S) — dedicated slots only
        if (f.includes('e1.s') || f.includes('e3.s'))
            return sk.includes('e1.s') || sk.includes('e3.s');
        return true;
    }
    let total = 0;
    for (const [key, count] of Object.entries(slotMap || {})) {
        if (matches(key)) total += count;
    }
    return total;
}

function checkDiskSlotConflicts(product, nodeSpec, sections) {
    const warnings = [];
    const m2Total = Object.values(product.m2Slots || {}).reduce((s, v) => s + v, 0);

    // Group non-M.2 disks by form factor and check per ff-group
    const ffGroups = {}; // ff -> selected qty
    ['hdd', 'ssd'].forEach(key => {
        const sec = sections.find(s => s.key === key);
        if (!sec) return;
        for (const [optId, qty] of Object.entries(sec.selections)) {
            const opt = sec.options.find(o => o.id === optId);
            if (!opt) continue;
            if (opt.meta && opt.meta.isM2) {
                // M.2 handled below
            } else {
                const ff = (opt.meta && opt.meta.formFactor) || '';
                ffGroups[ff] = (ffGroups[ff] || 0) + qty;
            }
        }
    });

    // For each form factor group, check against compatible slot count
    for (const [ff, selectedQty] of Object.entries(ffGroups)) {
        const compatSlots = _countCompatibleSlots(nodeSpec.frontDiskSlots, ff) +
                            _countCompatibleSlots(nodeSpec.rearDiskSlots,  ff);
        if (compatSlots > 0 && selectedQty > compatSlots) {
            const label = ff ? `${ff} 硬碟` : '硬碟';
            warnings.push(`${label}數量 (${selectedQty}) 超過相容槽位數 (${compatSlots})，請減少選配數量。`);
        }
    }

    // M.2 check
    let selectedM2 = 0;
    const ssdSec = sections.find(s => s.key === 'ssd');
    if (ssdSec) {
        for (const [optId, qty] of Object.entries(ssdSec.selections)) {
            const opt = ssdSec.options.find(o => o.id === optId);
            if (opt && opt.meta && opt.meta.isM2) selectedM2 += qty;
        }
    }
    if (m2Total > 0 && selectedM2 > m2Total) {
        warnings.push(`M.2 SSD 數量 (${selectedM2}) 超過 M.2 槽位數 (${m2Total})，請減少選配數量。`);
    }

    return warnings;
}

// -----------------------------------------------
// Conflict checker (non-PCIe rules)
// -----------------------------------------------
function checkSpecConflicts(product, nodeSpec, sections) {
    const warnings = [...checkDiskSlotConflicts(product, nodeSpec, sections)];

    // SAS → RAID or HBA required
    if (_getSASCount(sections) > 0) {
        const hasAdapter = sections.some(s => (s.key === 'raid' || s.key === 'hba') && Object.keys(s.selections).length > 0);
        if (!hasAdapter) warnings.push('SAS drives require a RAID card or HBA card.');
    }

    // RAID NVMe capacity = internalPorts / 4
    const raidSec = sections.find(s => s.key === 'raid');
    if (raidSec && Object.keys(raidSec.selections).length > 0) {
        const nvmeCount = _countNvme(sections);
        if (nvmeCount > 0) {
            for (const [optId] of Object.entries(raidSec.selections)) {
                const opt = raidSec.options.find(o => o.id === optId);
                if (opt && opt.meta) {
                    const maxNvme = Math.floor(opt.meta.internalPorts / 4);
                    if (nvmeCount > maxNvme) {
                        warnings.push(`${opt.name} supports max ${maxNvme} NVMe drives (${opt.meta.internalPorts}i ÷ 4). ${nvmeCount} selected.`);
                    }
                }
            }
        }
    }

    // M.2 on Board: only 2280 unless M.2 RAID card selected
    const ssdSec = sections.find(s => s.key === 'ssd');
    const m2raidSec = sections.find(s => s.key === 'm2raid');
    const hasM2Raid = m2raidSec && Object.keys(m2raidSec.selections).length > 0;
    if (ssdSec) {
        for (const [optId] of Object.entries(ssdSec.selections)) {
            const opt = ssdSec.options.find(o => o.id === optId);
            if (opt && opt.meta && opt.meta.isM2 && opt.meta.m2Length === '22110' && !hasM2Raid) {
                warnings.push(`M.2 22110 SSDs require an M.2 RAID card. On-board M.2 slots are limited to 2280 length.`);
            }
        }
    }

    return warnings;
}
