// ============================================
// PCIe Slot Compatibility Engine
// ============================================

// Which card interfaces a slot type can accept
const SLOT_ACCEPTS = {
    'PCIe x16 double width': ['PCIe x16 double width', 'PCIe x16', 'PCIe x8'],
    'PCIe x16': ['PCIe x16', 'PCIe x8'],
    'PCIe x8': ['PCIe x8'],
    'OCP3.0 x16': ['OCP3.0 x16', 'OCP3.0 x8'],
    'OCP3.0 x8': ['OCP3.0 x8'],
};

// Higher-priority (more constrained) cards are assigned first
const INTERFACE_PRIORITY = {
    'PCIe x16 double width': 0,
    'OCP3.0 x16': 1,
    'OCP3.0 x8': 2,
    'PCIe x16': 3,
    'PCIe x8': 4,
};

// Prefer fitting a card into the smallest compatible slot
const SLOT_SIZE = {
    'OCP3.0 x8': 0,
    'OCP3.0 x16': 1,
    'PCIe x8': 2,
    'PCIe x16': 3,
    'PCIe x16 double width': 4,
};

function validatePcieSlots(product, sections) {
    const cardRequests = [];
    sections.forEach(section => {
        for (const [optId, qty] of Object.entries(section.selections)) {
            const opt = section.options.find(o => o.id === optId);
            if (!opt || !opt.pcieInterface) continue;
            for (let i = 0; i < qty; i++) {
                cardRequests.push({
                    sectionKey: section.key,
                    optionId: optId,
                    name: opt.name,
                    iface: opt.pcieInterface,
                });
            }
        }
    });

    // 1U chassis with RAID card requires an extra PCIe x8 slot for the BBU
    const is1U = product.formFactor === '1u';
    const hasRaid = sections.some(s => s.key === 'raidCard' && Object.keys(s.selections).some(id => id !== 'none'));
    if (is1U && hasRaid) {
        cardRequests.push({
            sectionKey: 'raidCard',
            optionId: '_bbu',
            name: 'RAID BBU (1U)',
            iface: 'PCIe x8',
        });
    }

    const slots = product.pcieSlots.map((type, idx) => ({
        index: idx,
        type: type,
        assigned: null,
    }));

    // Sort cards by priority so the most-constrained cards get first pick
    const sortedCards = [...cardRequests].sort((a, b) =>
        (INTERFACE_PRIORITY[a.iface] ?? 99) - (INTERFACE_PRIORITY[b.iface] ?? 99)
    );

    const assignments = [];
    const unassigned = [];

    for (const card of sortedCards) {
        const compatibleSlots = slots
            .filter(s => !s.assigned && SLOT_ACCEPTS[s.type] && SLOT_ACCEPTS[s.type].includes(card.iface))
            .sort((a, b) => (SLOT_SIZE[a.type] ?? 99) - (SLOT_SIZE[b.type] ?? 99));

        if (compatibleSlots.length > 0) {
            const slot = compatibleSlots[0];
            slot.assigned = card;
            assignments.push({ slot: slot, card: card });
        } else {
            unassigned.push(card);
        }
    }

    const warnings = [];
    if (unassigned.length > 0) {
        const names = unassigned.map(c => c.name).join(', ');
        warnings.push(`Not enough compatible PCIe slots for: ${names}`);
    }

    return {
        assignments,
        unassigned,
        slotStatus: slots,
        warnings,
        totalCards: cardRequests.length,
        totalSlots: slots.length,
    };
}
