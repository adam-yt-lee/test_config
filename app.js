// ============================================
// Shared State
// ============================================
let products = [];
let filterCategories = [];
let selectedFilters = {};
let selectedProduct = null;
let configSectionDefs = [];
let activeNodeConfigs = [];   // [{ nodeId, nodeSpec, qty, sections }]
let editingCartIndex = -1;
let cartItems = JSON.parse(localStorage.getItem('serverCartItems') || '[]');
// Populated by dataLoader from SpecMapping.csv:
//   { commodity_type: { product_spec: [subgroup, ...] } }
let specMapping = {};

// ============================================
// Disk slot → compatible SSD form factors
// Driven by SpecMapping.csv (commodity_type = "ssd").
// Falls back to built-in rules when the mapping is not yet loaded.
// ============================================
function getSSDFormFactorsForSlot(slotType) {
    const s = slotType.toLowerCase();
    const rules = specMapping['ssd'];
    if (rules && rules.length) {
        const ffs = new Set();
        rules.forEach(r => {
            if (s.includes(r.spec) && (!r.also || s.includes(r.also))) ffs.add(r.value);
        });
        return [...ffs];
    }
    // Fallback (pre-load or missing CSV)
    if (s.includes('m.2_22110')) return ['M.2-22110', 'M.2-2280'];
    if (s.includes('m.2_2280')) return ['M.2-2280'];
    if (s.includes('e1.s')) return ['E1.S'];
    if (s.includes('e3.s')) return ['E3.S'];
    if (s.includes('15mm')) return ['U.2-15mm'];
    if (s.includes('9.5mm') || s.includes('7mm')) {
        const ffs = ['U.2-7mm'];
        if (s.includes('sata') || s.includes('sas')) ffs.push('SSD-2.5');
        return ffs;
    }
    return [];
}

// ============================================
// Count compatible non-M.2 disk slots for a given disk option.
// Uses the disk's form factor to determine which bay keys are valid.
//
// Disk form factor → compatible bays:
//   3.5" (HDD-3.5)           → only slots whose key contains "3.5"
//   2.5"/U.2/U.3 (SSD-2.5, U.2-*) → slots whose key contains "2.5" or "3.5" (adapter)
//   E1.S / E3.S (EDSFF)     → only slots whose key contains "e1.s" / "e3.s"
//   Unknown                  → all slots (fallback)
// ============================================
function countCompatibleDiskSlots(nodeSpec, diskMeta) {
    const front = nodeSpec.frontDiskSlots || {};
    const rear  = nodeSpec.rearDiskSlots  || {};
    const all   = { ...front, ...rear };

    const ff = diskMeta && diskMeta.formFactor
        ? diskMeta.formFactor.toLowerCase()
        : (diskMeta && diskMeta.formFactorNorm ? diskMeta.formFactorNorm.toLowerCase() : '');
    const ffNorm = diskMeta && diskMeta.formFactorNorm
        ? diskMeta.formFactorNorm : '';

    // Determine which slot keys are compatible
    let filter;
    if (ff.includes('3.5') || ffNorm === 'HDD-3.5') {
        // 3.5" drives only fit 3.5" bays
        filter = k => k.toLowerCase().includes('3.5');
    } else if (ff.includes('e1.s') || ffNorm === 'E1.S') {
        filter = k => k.toLowerCase().includes('e1.s');
    } else if (ff.includes('e3.s') || ffNorm === 'E3.S') {
        filter = k => k.toLowerCase().includes('e3.s');
    } else if (ff.includes('2.5') || ff.includes('u.2') || ff.includes('u.3') ||
               ff.includes('7mm') || ff.includes('9.5mm') || ff.includes('15mm') ||
               ffNorm === 'SSD-2.5' || (ffNorm && ffNorm.startsWith('U.2'))) {
        // 2.5" / U.2 / U.3 drives fit both 2.5" and 3.5" bays (with adapter)
        filter = k => { const kl = k.toLowerCase(); return kl.includes('2.5') || kl.includes('3.5'); };
    } else if (ff) {
        // Unknown but has a form factor string — try substring match, fallback to all
        filter = k => k.toLowerCase().includes(ff) || true;
    } else {
        // Completely unknown — count all slots as fallback
        filter = () => true;
    }

    let total = 0;
    for (const [key, count] of Object.entries(all)) {
        if (filter(key)) total += count;
    }
    return total || 1; // At least 1 to avoid 0
}

// ============================================
// ConfigSection class
// ============================================
class ConfigSection {
    constructor({ key, name, type, dependsOn, options, defaultQty, showQtyCtrl }) {
        this.key = key;
        this.name = name;
        this.type = type;          // 'single' | 'multi' | 'optional'
        this.dependsOn = dependsOn; // null | 'disk' | 'nic' | 'raid'
        this.options = options;
        this.selections = {};
        this.defaultQty = defaultQty || 1;
        this.showQtyCtrl = showQtyCtrl || false;
    }

    select(optionId) {
        const opt = this.options.find(o => o.id === optionId);
        if (!opt) return;
        if (this.type === 'single') {
            this.selections = {};
            this.selections[optionId] = this.defaultQty;
        } else {
            if (this.selections[optionId] !== undefined) delete this.selections[optionId];
            else this.selections[optionId] = this.defaultQty;
        }
    }

    setQty(optionId, qty) {
        if (this.selections[optionId] !== undefined) {
            this.selections[optionId] = Math.max(1, parseInt(qty) || 1);
        }
    }

    getSelections() { return { ...this.selections }; }

    getSummary() {
        const entries = Object.entries(this.selections);
        if (!entries.length) return 'Not selected';
        return entries.map(([id, qty]) => {
            const opt = this.options.find(o => o.id === id);
            const name = opt ? opt.name : id;
            return qty > 1 ? qty + '\u00d7 ' + name : name;
        }).join(', ');
    }

    isValid() {
        if (this.type === 'optional') return true;
        return Object.keys(this.selections).length > 0;
    }

    loadSelections(sel) {
        this.selections = {};
        if (sel && typeof sel === 'object') {
            for (const [id, qty] of Object.entries(sel)) {
                if (this.options.find(o => o.id === id)) this.selections[id] = parseInt(qty) || 1;
            }
        }
    }

    // Render as a collapsible row with "+" button
    render(uid) {
        const hasSelections = Object.keys(this.selections).length > 0;
        const summary = hasSelections ? this.getSummary() : 'Not selected';
        const typeLabel = { single: '必選', multi: '多選', optional: '選填' }[this.type] || this.type;

        let html = `<div class="config-section" data-key="${this.key}">
            <div class="config-section-header">
                <div class="section-title-group">
                    <span class="section-name">${this.name}</span>
                    <span class="section-type-badge cfg-${this.type}">${typeLabel}</span>
                </div>
                <span class="section-summary" id="sum-${uid}">${summary}</span>
                <button class="section-plus-btn" id="btn-${uid}" onclick="toggleSectionPanel('${uid}')" title="選擇料號">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                    </svg>
                </button>
            </div>
            <div class="config-section-panel" id="panel-${uid}" style="display:none">`;

        html += this._renderPanelContent(uid);
        html += `</div></div>`;
        return html;
    }

    _renderPanelContent(uid) {
        if (this.dependsOn === 'disk') return this._renderDiskDependentPanel(uid);
        if (this.dependsOn === 'nic')  return this._renderNicDependentPanel(uid);
        if (this.dependsOn === 'raid') return this._renderRaidDependentPanel(uid);
        return this._renderOptionList(uid);
    }

    _renderOptionList(uid) {
        if (!this.options.length) return '<div class="panel-empty">No compatible options available.</div>';
        let html = '<div class="option-list">';
        this.options.forEach(opt => {
            const isSelected = this.selections[opt.id] !== undefined;
            const qty = isSelected ? this.selections[opt.id] : 1;
            html += `<label class="config-option ${isSelected ? 'selected' : ''}">
                <input type="checkbox" value="${opt.id}" ${isSelected ? 'checked' : ''}
                    onchange="onSectionSelect('${uid}', '${opt.id}')">
                <span class="check-dot"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="8" fill="none"><path fill="#fff" fill-rule="evenodd" d="M9.218.304a1 1 0 0 1-.022 1.414l-5.187 5a1 1 0 0 1-1.393 0L.804 4.99a1 1 0 0 1 1.392-1.436l1.117 1.052L7.803.282a1 1 0 0 1 1.415.022" clip-rule="evenodd"/></svg></span>
                <div class="option-text">
                    <div class="option-name">${opt.name}</div>
                    <div class="option-desc">${opt.desc}</div>
                </div>
                ${this.type !== 'single' && isSelected ? `<div class="option-qty-ctrl">
                    <button onclick="adjustOptQty(event,'${uid}','${opt.id}',-1)">&#8722;</button>
                    <span id="qty-${uid}-${opt.id}">${qty}</span>
                    <button onclick="adjustOptQty(event,'${uid}','${opt.id}',1)">&#43;</button>
                </div>` : ''}
            </label>`;
        });
        html += '</div>';
        return html;
    }

    _renderDiskDependentPanel(uid) {
        // Will be filled by refreshDependentSection()
        return `<div class="dep-panel" id="dep-${uid}">
            <div class="dep-hint"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
            請先選擇硬碟 (HDD / SSD)</div></div>`;
    }

    _renderNicDependentPanel(uid) {
        return `<div class="dep-panel" id="dep-${uid}">
            <div class="dep-hint"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
            請先選擇 NIC Card</div></div>`;
    }

    _renderRaidDependentPanel(uid) {
        return `<div class="dep-panel" id="dep-${uid}">
            <div class="dep-hint"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
            請先選擇 RAID Card</div></div>`;
    }
}

// ============================================
// Create config sections for a product + node spec
// ============================================
function createConfigSections(product, nodeSpec) {
    const sections = [];

    const allDiskSlots = [
        ...Object.keys(nodeSpec.frontDiskSlots || {}),
        ...Object.keys(nodeSpec.rearDiskSlots  || {}),
    ];
    const hasDisks  = allDiskSlots.length > 0;
    // Use SpecMapping "hdd" rules to identify HDD-compatible slots (fallback: "3.5" substring)
    const hddRules  = specMapping['hdd'] || [];
    const has35Slot = allDiskSlots.some(s => {
        const sl = s.toLowerCase();
        if (hddRules.length) return hddRules.some(r => sl.includes(r.spec) && (!r.also || sl.includes(r.also)));
        return sl.includes('3.5');
    });
    const hasM2        = Object.keys(product.m2Slots || {}).length > 0;

    const compatSSDFF = new Set();
    allDiskSlots.forEach(slot => getSSDFormFactorsForSlot(slot).forEach(ff => compatSSDFF.add(ff)));
    if (hasM2) {
        compatSSDFF.add('M.2-2280');
        if (product.m2MaxLength === '22110') compatSSDFF.add('M.2-22110');
    }
    const hasAnySSD = compatSSDFF.size > 0;

    // Helper: get def and filter options
    const def = key => configSectionDefs.find(d => d.key === key);

    // Helper: resolve compatible commodity values from SpecMapping for cpu/dimm/gpu.
    // specKey may be composite ("xeon-5*2|xeon-4*2") – each token is checked.
    // Returns array of matching values, or null if no mapping found (→ show all).
    function resolveSubGroups(commodity_type, specKey) {
        const rules = specMapping[commodity_type] || [];
        const tokens = specKey.replace(/\*\d+/g, '').split('|').map(s => s.trim().toLowerCase());
        const groups = new Set();
        tokens.forEach(tok => {
            rules.forEach(r => {
                // For cpu/dimm/gpu, also is unused; spec is an exact product key token
                if (tok.includes(r.spec)) groups.add(r.value);
            });
        });
        return groups.size > 0 ? [...groups] : null;
    }

    // Helper: check if a slot type matches any nic OCP pattern from SpecMapping
    function slotNICTypes(slotType) {
        const s = slotType.toLowerCase();
        const rules = specMapping['nic'] || [];
        const types = new Set();
        rules.forEach(r => { if (s.includes(r.spec)) types.add(r.value.toLowerCase()); });
        return types;
    }

    // --- CPU ---
    const cpuDef = def('cpu');
    if (cpuDef) {
        const groups = resolveSubGroups('cpu', product.cpuSeries);
        const opts = groups ? cpuDef.options.filter(o => groups.includes(o.subGroup)) : cpuDef.options;
        if (opts.length) sections.push(new ConfigSection({ key: 'cpu', name: `CPU ×${product.cpuSockets}`, type: 'single', dependsOn: null, options: opts, defaultQty: product.cpuSockets, showQtyCtrl: true }));
    }

    // --- DIMM ---
    const dimmDef = def('dimm');
    if (dimmDef && product.dimmSlots > 0) {
        const groups = resolveSubGroups('dimm', product.dimmType);
        const opts = groups ? dimmDef.options.filter(o => groups.includes(o.subGroup))
                           : dimmDef.options.filter(o => o.subGroup === product.dimmType);
        const optsWithInfo = opts.map(o => ({ ...o, desc: o.desc + ` | ${product.dimmSlots} 槽` }));
        if (optsWithInfo.length) sections.push(new ConfigSection({ key: 'dimm', name: `DIMM ×${product.dimmSlots}`, type: 'single', dependsOn: null, options: optsWithInfo, defaultQty: product.dimmSlots, showQtyCtrl: true }));
    }

    // --- GPU ---
    if (product.gpus > 0) {
        const gpuDef = def('gpu');
        if (gpuDef) {
            // Collect compatible sub-groups for all gpuType tokens
            const allGpuGroups = new Set();
            product.gpuType.filter(t => t && t !== 'none').forEach(gpuToken => {
                const groups = resolveSubGroups('gpu', gpuToken);
                if (groups) groups.forEach(g => allGpuGroups.add(g));
            });
            const opts = allGpuGroups.size > 0
                ? gpuDef.options.filter(o => allGpuGroups.has(o.subGroup))
                : gpuDef.options;
            if (opts.length) sections.push(new ConfigSection({ key: 'gpu', name: `GPU / Accelerator (${product.gpus} units)`, type: 'single', dependsOn: null, options: opts }));
        }
    }

    // --- HDD ---
    if (has35Slot) {
        const hddDef = def('hdd');
        if (hddDef && hddDef.options.length) {
            sections.push(new ConfigSection({ key: 'hdd', name: 'HDD', type: 'optional', dependsOn: null, options: hddDef.options }));
        }
    }

    // --- SSD ---
    if (hasAnySSD) {
        const ssdDef = def('ssd');
        if (ssdDef) {
            const opts = ssdDef.options.filter(o => compatSSDFF.has(o.meta.formFactorNorm));
            if (opts.length) sections.push(new ConfigSection({ key: 'ssd', name: 'SSD / NVMe', type: 'optional', dependsOn: null, options: opts }));
        }
    }

    // --- NIC ---
    const nicDef = def('nic');
    if (nicDef) {
        const allSchemeSlots = (nodeSpec.pcieSlotSchemes || []).flatMap(s => s.slots);
        const allNICSlots = [...allSchemeSlots, ...(product.ocpSlots || [])];
        const nicRules = specMapping['nic'] || [];
        const hasOCP = allNICSlots.some(s => {
            const sl = s.toLowerCase();
            if (nicRules.length) return nicRules.some(r => sl.includes(r.spec) && r.value.toLowerCase().startsWith('ocp'));
            return s.startsWith('OCP');
        });
        const opts = nicDef.options.filter(o => o.meta.isOCP ? hasOCP : true);
        if (opts.length) sections.push(new ConfigSection({ key: 'nic', name: 'NIC Card', type: 'multi', dependsOn: null, options: opts }));
    }

    // --- HBA ---
    if (hasDisks || hasM2) {
        const hbaDef = def('hba');
        if (hbaDef && hbaDef.options.length) {
            sections.push(new ConfigSection({ key: 'hba', name: 'HBA Card', type: 'optional', dependsOn: null, options: hbaDef.options }));
        }
    }

    // --- RAID ---
    if (hasDisks || hasM2) {
        const raidDef = def('raid');
        if (raidDef && raidDef.options.length) {
            sections.push(new ConfigSection({ key: 'raid', name: 'RAID', type: 'optional', dependsOn: 'disk', options: raidDef.options }));
        }
    }

    // --- M.2 RAID ---
    if (hasM2) {
        const m2rDef = def('m2raid');
        if (m2rDef && m2rDef.options.length) {
            sections.push(new ConfigSection({ key: 'm2raid', name: 'M.2 RAID', type: 'optional', dependsOn: 'disk', options: m2rDef.options }));
        }
    }

    // --- BBU ---
    const bbuDef = def('bbu');
    if (bbuDef && bbuDef.options.length) {
        sections.push(new ConfigSection({ key: 'bbu', name: 'BBU (Battery Backup)', type: 'optional', dependsOn: 'raid', options: bbuDef.options }));
    }

    // --- Transceiver ---
    const transDef = def('transceiver');
    if (transDef && transDef.options.length) {
        sections.push(new ConfigSection({ key: 'transceiver', name: 'Transceiver', type: 'optional', dependsOn: 'nic', options: transDef.options }));
    }

    return sections;
}

// ============================================
// Section UID helpers
// ============================================
function makeUID(nodeIdx, sectionKey) {
    return `n${nodeIdx}_${sectionKey}`;
}

function parseSectionUID(uid) {
    const m = uid.match(/^n(\d+)_(.+)$/);
    if (!m) return null;
    return { nodeIdx: parseInt(m[1]), sectionKey: m[2] };
}

function findSectionByUID(uid) {
    const p = parseSectionUID(uid);
    if (!p) return null;
    const nc = activeNodeConfigs[p.nodeIdx];
    if (!nc) return null;
    return nc.sections.find(s => s.key === p.sectionKey) || null;
}

// ============================================
// Label helpers
// ============================================
function buildLabelMap() {
    const m = {};
    filterCategories.forEach(cat => cat.options.forEach(opt => { m[`${cat.key}:${opt.value}`] = opt.label; }));
    return m;
}
function getLabel(m, key, val) { return m[`${key}:${val}`] || val; }

// ============================================
// Cart Persistence
// ============================================
function persistCart() {
    localStorage.setItem('serverCartItems', JSON.stringify(cartItems));
    updateCartBadge();
}

function updateCartBadge() {
    const badge = document.getElementById('cart-badge');
    if (badge) {
        badge.textContent = cartItems.length;
        badge.style.display = cartItems.length > 0 ? 'flex' : 'none';
    }
}

function resolveConfigSummary(sectionKey, selections) {
    if (!selections || Object.keys(selections).length === 0) return '<em style="color:#94a3b8;">Not selected</em>';
    const def = configSectionDefs.find(d => d.key === sectionKey);
    if (!def) return JSON.stringify(selections);
    return Object.entries(selections).map(([optId, qty]) => {
        const opt = def.options.find(o => o.id === optId);
        const name = opt ? opt.name : optId;
        return qty > 1 ? qty + '\u00d7 ' + name : name;
    }).join(', ');
}

// ============================================
// Filter State Persistence
// ============================================
function saveFilterState() {
    const obj = {};
    for (const [key, values] of Object.entries(selectedFilters)) obj[key] = [...values];
    sessionStorage.setItem('serverFilters', JSON.stringify(obj));
}

function loadFilterState() {
    try {
        const saved = sessionStorage.getItem('serverFilters');
        if (saved) {
            const obj = JSON.parse(saved);
            for (const [key, arr] of Object.entries(obj)) selectedFilters[key] = new Set(arr);
        }
    } catch(e) {}
}
