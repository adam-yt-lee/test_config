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
// -----------------------------------------------
function validatePcieSlots(product, nodeSpec, sections) {
    // Build available slots (PCIe + OCP), adjusting for 2U NVMe-24 rule
    let pcieSlots = [...(nodeSpec ? nodeSpec.pcieSlots : (product.nodes && product.nodes[0] ? product.nodes[0].pcieSlots : []))];
    const ocpSlots = [...(product.ocpSlots || [])];

    // Rule: 2U NVMe 24 drives → G4-FHFL-x16 loses 2 slots (NVMe backplane)
    if (product.formFactor === '2ru') {
        const nvme24Selected = _countNvme(sections);
        if (nvme24Selected >= 24) {
            let removed = 0;
            pcieSlots = pcieSlots.filter(s => {
                if (s === 'G4-FHFL-x16' && removed < 2) { removed++; return false; }
                return true;
            });
        }
    }

    const allSlotTypes = [...pcieSlots, ...ocpSlots];
    const slots = allSlotTypes.map((type, idx) => ({ index: idx, type, assigned: null }));

    const cardRequests = buildCardRequests(product, nodeSpec, sections);
    const sortedCards  = [...cardRequests].sort((a, b) =>
        (INTERFACE_PRIORITY[a.iface] ?? 99) - (INTERFACE_PRIORITY[b.iface] ?? 99)
    );

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

    const warnings = [];
    if (unassigned.length > 0) {
        warnings.push(`Not enough compatible PCIe slots for: ${unassigned.map(c => c.name).join(', ')}`);
    }

    // SAS drives must have RAID or HBA
    const sasDrives = _getSASCount(sections);
    const hasRaidOrHBA = sections.some(s => (s.key === 'raid' || s.key === 'hba') && Object.keys(s.selections).length > 0);
    if (sasDrives > 0 && !hasRaidOrHBA) {
        warnings.push(`SAS drives require a RAID card or HBA card to be selected.`);
    }

    return {
        assignments, unassigned, slotStatus: slots, warnings,
        totalCards: cardRequests.length, totalSlots: slots.length,
    };
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
// Conflict checker (non-PCIe rules)
// -----------------------------------------------
function checkSpecConflicts(product, sections) {
    const warnings = [];

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
