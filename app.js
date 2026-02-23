// ============================================
// Shared State
// ============================================
let products = [];
let filterCategories = [];
let selectedFilters = {};
let selectedProduct = null;
let configSectionDefs = [];
let activeConfigSections = [];
let cartItems = JSON.parse(localStorage.getItem('serverCartItems') || '[]');
let editingCartIndex = -1;

// ============================================
// ConfigSection Class
// ============================================
class ConfigSection {
    constructor({ key, name, type, options }) {
        this.key = key;
        this.name = name;
        this.type = type;
        this.options = options;
        this.selections = {};
    }

    select(optionId) {
        const opt = this.options.find(o => o.id === optionId);
        if (!opt) return;
        if (this.type === 'single') {
            this.selections = {};
            this.selections[optionId] = opt.defaultQty;
        } else {
            if (this.selections[optionId] !== undefined) {
                delete this.selections[optionId];
            } else {
                this.selections[optionId] = opt.defaultQty;
            }
        }
    }

    deselect(optionId) {
        delete this.selections[optionId];
    }

    setQty(optionId, qty) {
        const opt = this.options.find(o => o.id === optionId);
        if (!opt || !opt.qtyEditable) return;
        if (this.selections[optionId] !== undefined) {
            this.selections[optionId] = Math.max(0, parseInt(qty) || 0);
        }
    }

    getSelections() {
        return { ...this.selections };
    }

    getSummary() {
        const entries = Object.entries(this.selections);
        if (entries.length === 0) return 'Not selected';
        return entries.map(([id, qty]) => {
            const opt = this.options.find(o => o.id === id);
            return opt ? (qty > 1 ? qty + '\u00d7 ' + opt.name : opt.name) : id;
        }).join(', ');
    }

    isValid() {
        if (this.type === 'optional') return true;
        return Object.keys(this.selections).length > 0;
    }

    loadSelections(selections) {
        this.selections = {};
        if (selections && typeof selections === 'object') {
            for (const [id, qty] of Object.entries(selections)) {
                if (this.options.find(o => o.id === id)) {
                    this.selections[id] = parseInt(qty) || 0;
                }
            }
        }
    }

    render() {
        const summary = this.getSummary();
        const isOpen = Object.keys(this.selections).length === 0;
        const typeLabel = this.type === 'single' ? 'Single' : this.type === 'multi' ? 'Multi' : 'Optional';

        let html = `<div class="config-section ${isOpen ? 'open' : ''}" data-key="${this.key}">
            <div class="config-section-header" onclick="toggleSection(this)">
                <span class="config-section-label">${this.name}</span>
                <span class="config-section-type-badge config-type-${this.type}">${typeLabel}</span>
                <span class="config-section-value" id="summary-${this.key}">${summary}</span>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="config-section-chevron">
                    <path d="M2.29 7.29a.996.996 0 0 1 1.41 0l8.29 8.29 8.29-8.29a.996.996 0 1 1 1.41 1.41l-9 9a.996.996 0 0 1-1.41 0L2.29 8.71a.996.996 0 0 1 0-1.41Z" style="fill-rule:evenodd;"/>
                </svg>
            </div>
            <div class="config-section-body"><div class="config-option-list">`;

        this.options.forEach(opt => {
            const isSelected = this.selections[opt.id] !== undefined;
            const qty = isSelected ? this.selections[opt.id] : opt.defaultQty;

            html += `<label class="config-option ${isSelected ? 'selected' : ''}">
                    <input type="checkbox" name="cfg-${this.key}" value="${opt.id}" ${isSelected ? 'checked' : ''} onchange="onSectionSelect('${this.key}','${opt.id}')">
                    <span class="checkbox-dot">
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="8" fill="none" class="checkbox-check-icon">
                            <path fill="#fff" fill-rule="evenodd" d="M9.218.304a1 1 0 0 1-.022 1.414l-5.187 5a1 1 0 0 1-1.393 0L.804 4.99a1 1 0 0 1 1.392-1.436l1.117 1.052L7.803.282a1 1 0 0 1 1.415.022" clip-rule="evenodd"/>
                        </svg>
                    </span>
                    <div class="config-option-text">
                        <div class="config-option-name">${opt.name}</div>
                        <div class="config-option-desc">${opt.desc}</div>
                    </div>
                    <div class="config-option-qty">
                        <span class="qty-label">Qty:</span>
                        <input type="number" class="qty-input" value="${qty}" min="0" ${!opt.qtyEditable ? 'disabled' : ''} onchange="onSectionQty('${this.key}','${opt.id}',this.value)" onclick="event.stopPropagation()">
                    </div>
                </label>`;
        });

        html += '</div></div></div>';
        return html;
    }
}

// ============================================
// Build ConfigSection instances for a product
// ============================================
function createConfigSections(product) {
    return configSectionDefs.map(def => {
        if (def.key === 'dimm' && product.dimmSlots === 0) return null;

        const filteredOptions = def.options.filter(opt => {
            if (opt.appliesTo === '*') return true;
            return opt.appliesTo === product.cpuSeries;
        });

        if (filteredOptions.length === 0) return null;

        const clonedOptions = filteredOptions.map(opt => {
            const clone = { id: opt.id, name: opt.name, desc: opt.desc, defaultQty: opt.defaultQty, qtyEditable: opt.qtyEditable, pcieInterface: opt.pcieInterface || '' };
            if (def.key === 'dimm' && product.dimmSlots > 0) {
                const match = opt.name.match(/(\d+)GB/);
                if (match) {
                    const gb = parseInt(match[1]);
                    const total = gb * product.dimmSlots;
                    const totalStr = total >= 1024 ? (total / 1024) + 'TB' : total + 'GB';
                    clone.desc = opt.desc + ' / ' + product.dimmSlots + ' slots = ' + totalStr + ' Total';
                }
            }
            return clone;
        });

        return new ConfigSection({ key: def.key, name: def.name, type: def.type, options: clonedOptions });
    }).filter(Boolean);
}

// ============================================
// Label helpers
// ============================================
function buildLabelMap() {
    const m = {};
    filterCategories.forEach(cat => { cat.options.forEach(opt => { m[`${cat.key}:${opt.value}`] = opt.label; }); });
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
    if (!selections || (typeof selections === 'object' && Object.keys(selections).length === 0)) {
        return '<em style="color:#94a3b8;">Not selected</em>';
    }
    if (typeof selections === 'string') {
        const def = configSectionDefs.find(d => d.key === sectionKey);
        if (def) {
            const opt = def.options.find(o => o.id === selections);
            return opt ? opt.name : selections;
        }
        return selections;
    }
    const def = configSectionDefs.find(d => d.key === sectionKey);
    if (!def) return JSON.stringify(selections);
    return Object.entries(selections).map(([optId, qty]) => {
        const opt = def.options.find(o => o.id === optId);
        const name = opt ? opt.name : optId;
        return qty > 1 ? qty + '\u00d7 ' + name : name;
    }).join(', ');
}

// ============================================
// Filter State Persistence (sessionStorage)
// ============================================
function saveFilterState() {
    const obj = {};
    for (const [key, values] of Object.entries(selectedFilters)) {
        obj[key] = [...values];
    }
    sessionStorage.setItem('serverFilters', JSON.stringify(obj));
}

function loadFilterState() {
    try {
        const saved = sessionStorage.getItem('serverFilters');
        if (saved) {
            const obj = JSON.parse(saved);
            for (const [key, arr] of Object.entries(obj)) {
                selectedFilters[key] = new Set(arr);
            }
        }
    } catch(e) {}
}
