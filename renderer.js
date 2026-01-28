const { ipcRenderer } = require('electron');
const XLSX = require('xlsx');

// Global cache for party types
const partyTypes = {};
let salesChartInstance = null;
let expenseChartInstance = null;
let currentRole = null; // Global variable for user role

const DEFAULT_API_BASE = 'http://127.0.0.1:8000';
let apiBase = DEFAULT_API_BASE;

function normalizeApiBase(url) {
    const trimmed = (url || '').trim();
    if (!trimmed) return DEFAULT_API_BASE;
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    return withProto.replace(/\/$/, '');
}

async function loadClientConfig() {
    try {
        const fs = require('fs');
        const path = require('path');
        const userDataPath = await ipcRenderer.invoke('app:getUserDataPath');
        const configPath = path.join(userDataPath, 'db_config.json');
        if (!fs.existsSync(configPath)) return {};
        const raw = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(raw || '{}');
    } catch (e) {
        return {};
    }
}

async function saveClientConfig(configJson) {
    const fs = require('fs');
    const path = require('path');
    const userDataPath = await ipcRenderer.invoke('app:getUserDataPath');
    const configPath = path.join(userDataPath, 'db_config.json');
    fs.writeFileSync(configPath, JSON.stringify(configJson, null, 2), 'utf8');
}

async function initApiBase() {
    const cfg = await loadClientConfig();
    if (cfg.api_base) {
        apiBase = normalizeApiBase(cfg.api_base);
    }
}

const originalFetch = window.fetch.bind(window);
window.fetch = (url, options) => {
    if (typeof url === 'string' && url.startsWith(DEFAULT_API_BASE)) {
        url = url.replace(DEFAULT_API_BASE, apiBase);
    }
    return originalFetch(url, options);
};

// Database Configuration Functions - defined early for inline handlers
function showDbConfig() {
    console.log('showDbConfig called');
    const modal = document.getElementById('dbConfigModal');
    if (modal) {
        modal.style.display = 'flex';
        loadDbConfig();
    } else {
        console.error('dbConfigModal not found');
    }
}

function closeDbConfig() {
    const modal = document.getElementById('dbConfigModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

function toggleSqlAuth() {
    const authType = document.getElementById('cfgAuthType').value;
    const sqlFields = document.getElementById('sqlAuthFields');
    if (sqlFields) {
        sqlFields.style.display = authType === 'sql' ? 'block' : 'none';
    }
}

// Declare testDbConnection and saveDbConfig as window functions (will be defined later)
// This allows inline handlers to work
window.showDbConfig = showDbConfig;
window.closeDbConfig = closeDbConfig;
window.toggleSqlAuth = toggleSqlAuth;
// testDbConnection and saveDbConfig are assigned at the bottom of the file
window.installServerMode = installServerMode;
window.uninstallServerMode = uninstallServerMode;
window.restartBackend = restartBackend;
window.stopBackend = stopBackend;

async function loadParties() {
    try {
        const res = await fetch("http://127.0.0.1:8000/parties");
        const data = await res.json();

        const datalist = document.getElementById("partyList");
        const reportDrop = document.getElementById("reportParty");
        
        // Build HTML strings first
        let datalistHTML = "";
        let reportDropHTML = '<option value="">Select Party</option>';

        data.forEach(p => {
            partyTypes[p.name] = p.type;
            datalistHTML += `<option value="${p.name}">`;
            reportDropHTML += `<option value="${p.name}">${p.name}</option>`;
        });
        
        // Set innerHTML once
        datalist.innerHTML = datalistHTML;
        reportDrop.innerHTML = reportDropHTML;
    } catch (e) {
        showToast("Error loading parties: " + e, "error");
    }
}

let currentTxnPage = 1;
let totalTxnPages = 1;
// Guard flag to prevent concurrent loadTransactions calls
// Multiple rapid calls cause DOM thrashing -> input fields freeze
// Fixed: Only one loadTransactions can run at a time
let isLoadingTransactions = false;

async function loadTransactions(page = 1) {
    // Prevent concurrent calls that cause DOM thrashing
    if (isLoadingTransactions) {
        console.log('loadTransactions: already loading, skipping...');
        return;
    }
    
    isLoadingTransactions = true;
    
    try {
        if (page < 1 || (page > totalTxnPages && totalTxnPages > 0)) {
            isLoadingTransactions = false;
            return;
        }
        
        console.time('loadTransactions-total');
        console.time('loadTransactions-fetch');
        const res = await fetch(`http://127.0.0.1:8000/transactions?page=${page}&limit=100`);
        const response = await res.json();
        
        // Validate response format
        if (!response || !response.transactions) {
            console.error('Invalid response format:', response);
            showToast("Error: Invalid server response", "error");
            return;
        }
        
        const data = response.transactions;
        currentTxnPage = response.page || 1;
        totalTxnPages = response.total_pages || 1;
        console.timeEnd('loadTransactions-fetch');
        console.log('Transaction count:', data.length);

        console.time('loadTransactions-render');
        const tbody = document.getElementById("transactionList");
        
        // Admin Edit Column Header (Recent Transactions Table)
        const headerRow = document.querySelector('#recentTxnTable thead tr');
        if (headerRow) {
            const existHeader = headerRow.querySelector('.action-header');
            if (existHeader) existHeader.remove();

            if (currentRole === 'admin') {
                const th = document.createElement('th');
                th.className = 'action-header';
                th.innerText = 'Action';
                headerRow.appendChild(th);
            }
        }

        // Build HTML string first, then set once - MUCH faster
        let rowsHTML = "";
        data.forEach(txn => {
            let actionCell = "";
            if (currentRole === 'admin') {
                actionCell = `<td class="action-cell">
                    <button class="btn-action edit" onclick="openEditModal('${txn.id}')" title="Edit">
                        <ion-icon name="create-outline"></ion-icon>
                        <span>Edit</span>
                    </button>
                    <button class="btn-action delete" onclick="if(!window.isDeleting) deleteTransaction('${txn.id}')" title="Delete">
                        <ion-icon name="trash-outline"></ion-icon>
                        <span>Del</span>
                    </button>
                </td>`;
            }

            rowsHTML += `
            <tr>
                <td>${formatDateShort(txn.date)}</td>
                <td>${txn.bill_no || ''}</td>
                <td>${txn.party}</td>
                <td>${txn.type}</td>
                <td>${txn.mode}</td>
                <td>${txn.amount.toFixed(2)}</td>
                ${actionCell}
            </tr>`;
        });
        
        // Set innerHTML once instead of 500 times
        tbody.innerHTML = rowsHTML;
        console.timeEnd('loadTransactions-render');

        // Set default date if not set
        const dateInput = document.getElementById("newDate");
        if (!dateInput.value) {
            dateInput.valueAsDate = new Date();
        }
        console.timeEnd('loadTransactions-total');
        
        // Update pagination controls
        const pageInfo = document.getElementById('txnPageInfo');
        const currentPageDisplay = document.getElementById('currentPageDisplay');
        const prevBtn = document.getElementById('prevPageBtn');
        const nextBtn = document.getElementById('nextPageBtn');
        
        if (pageInfo) pageInfo.textContent = `(${response.total} entries)`;
        if (currentPageDisplay) currentPageDisplay.textContent = `Page ${currentTxnPage} of ${totalTxnPages}`;
        if (prevBtn) prevBtn.disabled = currentTxnPage <= 1;
        if (nextBtn) nextBtn.disabled = currentTxnPage >= totalTxnPages;
        
        // Force ensure app is interactive after loading - AGGRESSIVE
        const appContent = document.getElementById('appContent');
        if (appContent) {
            appContent.style.setProperty('pointer-events', 'auto', 'important');
            appContent.style.setProperty('filter', 'none', 'important');
            appContent.style.setProperty('opacity', '1', 'important');
            // Force immediate reflow
            void appContent.offsetHeight;
        }
    } catch (e) {
        console.timeEnd('loadTransactions-total');
        showToast("Error loading transactions: " + e, "error");
    } finally {
        isLoadingTransactions = false;
    }
}

function incrementBillNumber(billNo) {
    if (!billNo || billNo.trim() === "") return "";
    
    // Match pattern: prefix (letters/symbols) + number
    // Examples: L-145, INV-99, BILL123, A1, 145
    const match = billNo.match(/^(.*?)(\d+)$/);
    
    if (!match) {
        // No number found, return as is
        return billNo;
    }
    
    const prefix = match[1]; // Everything before the number (e.g., "L-", "INV-", "BILL", "A")
    const numberPart = match[2]; // The numeric part (e.g., "145", "99")
    const numberLength = numberPart.length; // Preserve leading zeros
    
    // Increment the number
    const incremented = (parseInt(numberPart, 10) + 1).toString();
    
    // Pad with zeros if original had leading zeros
    const paddedNumber = incremented.padStart(numberLength, '0');
    
    return prefix + paddedNumber;
}

async function saveEntry() {
    const date = document.getElementById("newDate").value;
    const bill = document.getElementById("newBill").value;
    const partyInput = document.getElementById("newParty");
    const party = partyInput.value.trim();
    const type = document.getElementById("newType").value;
    const mode = document.getElementById("newMode").value;
    const amount = document.getElementById("newAmount").value;
    const isStrict = document.getElementById("strictPartyMode").checked;

    if (!date || !amount || !type || !mode || !party) {
        showToast("All fields (Date, Party, Type, Mode, Amount) are mandatory.", "error");
        return;
    }

    if (mode === "Credit") {
        const pType = partyTypes[party];
        if (pType && pType !== "Credit Customer") {
            showToast(`Credit Mode is NOT allowed for '${party}' (Type: ${pType}). Only 'Credit Customer' can take credit.`, "error");
            return;
        }
    }

    if (!party && mode === "Credit") {
        showToast("Credit transactions require a party.", "error");
        return;
    }

    const datalist = document.getElementById("partyList");
    let partyExists = false;
    for (let i = 0; i < datalist.options.length; i++) {
        if (datalist.options[i].value === party) {
            partyExists = true;
            break;
        }
    }

    if (!partyExists && party !== "") {
        if (isStrict) {
            showToast(`Party '${party}' not found. Create it in 'Manage > Add Party' first.`, "error");
            return;
        } else {
            if (confirm(`Party '${party}' does not exist. Create new Party?`)) {
                let pType = prompt("Enter Party Type (Customer, Credit Customer, Supplier, Expense Account, Bank):", "Customer");
                if (!pType) return;

                const isCredit = pType === "Credit Customer";
                await fetch(`http://127.0.0.1:8000/party?name=${party}&ptype=${pType}&credit=${isCredit}`, { method: "POST" });
                // Reload to update cache
                await loadParties();
            } else {
                return;
            }
        }
    }

    const partyParam = party ? party.replace(/ /g, "%20") : "customer";

    // Construct URL for POST
    const url = `http://127.0.0.1:8000/transaction?date=${date}&bill_no=${bill}&party=${partyParam}&txn_type=${type}&mode=${mode}&amount=${amount}`;

    try {
        console.time('saveEntry-POST');
        const res = await fetch(url, { method: "POST" });
        const data = await res.json();
        console.timeEnd('saveEntry-POST');

        const statusText = (data.status || "").toString().trim().toLowerCase();
        if (statusText.includes("added") || statusText.includes("saved") || statusText.includes("success")) {
            showToast("Entry Saved Successfully!", "success");
            console.time('saveEntry-reload');
            await loadTransactions(currentTxnPage);
            console.timeEnd('saveEntry-reload');
            
            // Auto-increment bill number
            const currentBill = bill;
            const nextBill = incrementBillNumber(currentBill);
            
            // Clear inputs
            document.getElementById("newBill").value = nextBill;
            document.getElementById("newParty").value = "";
            document.getElementById("newAmount").value = "";
            document.getElementById("newType").value = "Sale";
            document.getElementById("newMode").value = "Credit";
            document.getElementById("newBill").focus();
        } else {
            showToast("Error: " + JSON.stringify(data), "error");
        }
    } catch (e) {
        showToast("Network Error: " + e, "error");
    }
}

function handleEntryNavigation(event, nextFieldIdOrAction) {
    if (event.key === "Enter") {
        event.preventDefault();
        
        if (nextFieldIdOrAction === 'save') {
            // Save and focus will be handled by saveEntry
            saveEntry();
        } else {
            // Navigate to next field
            const nextField = document.getElementById(nextFieldIdOrAction);
            if (nextField) {
                nextField.focus();
                // If it's a select, open the dropdown
                if (nextField.tagName === 'SELECT') {
                    nextField.click();
                }
            }
        }
    }
}

async function createParty() {
    const name = document.getElementById("partyName").value;
    const type = document.getElementById("partyType").value;
    const credit = document.getElementById("creditAllowed").checked;

    if (!name) return showToast("Enter Party Name", "error");

    try {
        const res = await fetch(`http://127.0.0.1:8000/party?name=${name}&ptype=${type}&credit=${credit}`, { method: "POST" });
        const data = await res.json();
        if (data.status === "Party Created") {
            showToast("Party Created Successfully", "success");
            document.getElementById("partyName").value = "";
            loadParties();
        } else {
            showToast("Error: " + data.detail, "error");
        }
    } catch (e) {
        showToast("Error: " + e, "error");
    }
}

// View Switching
function showView(viewId) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    
    // Load data when switching to specific views
    if (viewId === 'entryView') {
        loadTransactions();
    } else if (viewId === 'ledgerView') {
        loadLedgerReport();
    } else if (viewId === 'dayBookView') {
        loadDayBook();
    }
}

// Reports
// Reports
async function loadLedgerReport() {
    const party = document.getElementById("reportParty").value;
    if (!party) return showToast("Select a party first", "error");

    const normalizedParty = party.toLowerCase().replace(/\s+/g, "_");

    // Get Dates
    const start = document.getElementById("ledgerStart").value;
    const end = document.getElementById("ledgerEnd").value;

    let url = `http://127.0.0.1:8000/ledger/${normalizedParty}`;
    const params = new URLSearchParams();
    if (start) params.append("start", start);
    if (end) params.append("end", end);
    if (start || end) url += `?${params.toString()}`;

    const res = await fetch(url);
    const data = await res.json();

    const tbody = document.getElementById("ledgerBody");
    tbody.innerHTML = "";

    // Admin Edit Column Header
    const headerRow = document.querySelector('#ledgerTable thead tr');
    // Remove if exists to avoid duplicates
    const existHeader = document.getElementById('editHeader');
    if (existHeader) existHeader.remove();

    if (currentRole === 'admin') {
        const th = document.createElement('th');
        th.id = 'editHeader';
        th.innerText = 'Action';
        // Append to end
        headerRow.appendChild(th);
    }

    let runningBalance = 0;

    data.forEach(row => {
        let actionCell = "";
        if (currentRole === 'admin') {
            actionCell = `<td class="action-cell">
                <button class="btn-action edit" onclick="openEditModal('${row.id}')">Edit</button>
            </td>`;
        }

        const typeRaw = (row.type || '').toString().trim();
        const type = typeRaw.toLowerCase();
        const mode = row.mode ? row.mode : '';
        const particulars = `${typeRaw}${mode ? ' / ' + mode : ''}`;
        const amt = Number(row.amount || 0);

        const debitTypes = new Set(['sale', 'expense', 'purchase']);
        const creditTypes = new Set(['receipt', 'reciept', 'sale return']);

        let debit = '';
        let credit = '';
        if (debitTypes.has(type)) {
            debit = amt.toFixed(2);
            runningBalance += amt;
        } else if (creditTypes.has(type)) {
            credit = amt.toFixed(2);
            runningBalance -= amt;
        } else {
            debit = amt.toFixed(2);
            runningBalance += amt;
        }

        const balanceLabel = runningBalance < 0
            ? `${Math.abs(runningBalance).toFixed(2)} Cr`
            : `${runningBalance.toFixed(2)} Dr`;

        tbody.innerHTML += `
        <tr>
            <td>${formatDateShort(row.date)}</td>
            <td>${row.bill_no || ''}</td>
            <td>${particulars}</td>
            <td class="text-right">${debit}</td>
            <td class="text-right">${credit}</td>
            <td class="text-right">${balanceLabel}</td>
            ${actionCell}
        </tr>`;
    });
}

// --- Edit Transaction Logic ---
function openEditModal(id) {
    const modal = document.getElementById('editTxnModal');
    if (!modal) return;
    
    modal.style.display = 'flex';
    modal.style.pointerEvents = 'auto';
    modal.style.visibility = 'visible';
    modal.style.zIndex = '2000';
    
    document.getElementById('editTxnId').value = id;
    document.getElementById('editValue').value = '';
    
    // Ensure modal is fully rendered before focusing input
    requestAnimationFrame(() => {
        document.getElementById('editValue').focus();
    });
}

function closeEditModal() {
    const modal = document.getElementById('editTxnModal');
    if (!modal) return;
    
    // Completely remove modal from layout and paint
    modal.style.setProperty('display', 'none', 'important');
    modal.style.setProperty('pointer-events', 'none', 'important');
    modal.style.setProperty('visibility', 'hidden', 'important');
    modal.style.setProperty('z-index', '-1', 'important');
    
    // Force browser to recalculate layout immediately
    void modal.offsetHeight;
    
    // Also ensure app is unlocked
    const appContent = document.getElementById('appContent');
    if (appContent) {
        appContent.style.setProperty('pointer-events', 'auto', 'important');
        appContent.style.setProperty('filter', 'none', 'important');
        appContent.style.setProperty('opacity', '1', 'important');
        void appContent.offsetHeight;
    }
    
    console.log('closeEditModal: Modal fully closed');
}

function ensureAppInteractive() {
    const appContent = document.getElementById('appContent');
    const loginModal = document.getElementById('loginModal');
    const editModal = document.getElementById('editTxnModal');
    const confirmModal = document.getElementById('confirmDeleteModal');
    const dbModal = document.getElementById('dbConfigModal');

    if (sessionStorage.getItem('username')) {
        if (loginModal) {
            loginModal.style.display = 'none';
            loginModal.style.pointerEvents = 'none';
        }
        if (appContent) {
            appContent.style.setProperty('filter', 'none', 'important');
            appContent.style.setProperty('pointer-events', 'auto', 'important');
            appContent.style.setProperty('opacity', '1', 'important');
            // Force reflow
            void appContent.offsetHeight;
        }
    }

    // Aggressively hide all modals
    if (editModal) {
        editModal.style.display = 'none';
        editModal.style.pointerEvents = 'none';
        editModal.style.visibility = 'hidden';
        void editModal.offsetHeight;
    }
    if (confirmModal) {
        confirmModal.style.display = 'none';
        confirmModal.style.pointerEvents = 'none';
    }
    if (dbModal) {
        dbModal.style.display = 'none';
        dbModal.style.pointerEvents = 'none';
    }
    
    // CRITICAL: Reset all input fields to ensure they're interactive
    const inputFields = ['newDate', 'newBill', 'newParty', 'newType', 'newMode', 'newAmount', 'newRemarks'];
    inputFields.forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            input.disabled = false;
            input.readOnly = false;
            input.style.pointerEvents = 'auto';
            input.style.opacity = '1';
            input.style.filter = 'none';
        }
    });
}

async function submitTxnEdit() {
    const id = document.getElementById('editTxnId').value;
    const field = document.getElementById('editField').value;
    const val = document.getElementById('editValue').value;

    if (!val) return showToast("Enter a value", "error");

    try {
        const res = await fetch("http://127.0.0.1:8000/transaction/edit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                txn_id: parseInt(id),
                admin_user: sessionStorage.getItem("username"),
                field: field,
                new_value: val
            })
        });

        const data = await res.json();
        if (data.status === "Updated Successfully") {
            showToast("Transaction Updated", "success");
            closeEditModal();
            ensureAppInteractive();
            
            // Small delay to let DOM settle before reload
            setTimeout(() => {
                if (isViewActive('ledgerView')) loadLedgerReport();
                loadTransactions(currentTxnPage);
                updateDashboard();
            }, 50);
        } else {
            showToast("Update Failed: " + data.detail, "error");
        }
    } catch (e) {
        showToast("Error: " + e, "error");
    }
}

let isDeleting = false;
let pendingDeleteId = null;

function showConfirmDelete(id) {
    const modal = document.getElementById('confirmDeleteModal');
    const okBtn = document.getElementById('confirmOkBtn');
    const cancelBtn = document.getElementById('confirmCancelBtn');
    
    pendingDeleteId = id;
    modal.style.display = 'flex';
    modal.style.pointerEvents = 'auto';
    modal.style.visibility = 'visible';
    modal.style.zIndex = '3000';
    
    // Remove any existing listeners
    const newOkBtn = okBtn.cloneNode(true);
    const newCancelBtn = cancelBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOkBtn, okBtn);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    
    // Add new listeners
    document.getElementById('confirmOkBtn').onclick = () => {
        modal.style.display = 'none';
        performDelete(pendingDeleteId);
    };
    
    document.getElementById('confirmCancelBtn').onclick = () => {
        modal.style.display = 'none';
        pendingDeleteId = null;
        openEditModal(id);
    };
}

async function deleteTransaction(id) {
    // Prevent concurrent deletes
    if (isDeleting) {
        console.log('Delete already in progress, ignoring...');
        return;
    }
    
    // Close edit modal and show confirmation
    closeEditModal();
    showConfirmDelete(id);
}

async function performDelete(id) {
    isDeleting = true;
    
    try {
        const res = await fetch("http://127.0.0.1:8000/transaction/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                txn_id: parseInt(id),
                admin_user: sessionStorage.getItem("username")
            })
        });

        const data = await res.json();
        if (data.status === "Deleted Successfully") {
            showToast("Transaction Deleted", "success");
            
            // Reload data
            if (isViewActive('ledgerView')) loadLedgerReport();
            await loadTransactions(currentTxnPage);
            updateDashboard();
            unlockUiAfterModal();
            
            // CRITICAL: Completely reset input interactivity
            setTimeout(() => {
                reactivateInputs();
                isDeleting = false;
            }, 100);
        } else {
            showToast("Delete Failed: " + data.detail, "error");
            isDeleting = false;
        }
    } catch (e) {
        showToast("Error: " + e, "error");
        isDeleting = false;
    }
}

function unlockUiAfterModal() {
    const appContent = document.getElementById('appContent');
    const loginModal = document.getElementById('loginModal');
    const editModal = document.getElementById('editTxnModal');
    const confirmModal = document.getElementById('confirmDeleteModal');
    const dbModal = document.getElementById('dbConfigModal');

    const rootEl = document.documentElement;
    const bodyEl = document.body;

    [rootEl, bodyEl, appContent].forEach(el => {
        if (!el) return;
        el.style.pointerEvents = 'auto';
        el.style.filter = 'none';
        el.style.opacity = '1';
    });

    [loginModal, editModal, confirmModal, dbModal].forEach(modal => {
        if (!modal) return;
        modal.style.display = 'none';
        modal.style.pointerEvents = 'none';
        modal.style.visibility = 'hidden';
        modal.style.zIndex = '-1';
    });

    if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
    }
}

function reactivateInputs() {
    console.log('Reactivating inputs...');
    unlockUiAfterModal();
    
    // 1. Force parent container reset
    const cardContainer = document.querySelector('#entryView .card');
    if (cardContainer) {
        const originalDisplay = cardContainer.style.display;
        cardContainer.style.display = 'none';
        void cardContainer.offsetHeight;
        cardContainer.style.display = originalDisplay || '';
    }
    
    // 2. Reset all input fields completely
    const inputFields = ['newDate', 'newBill', 'newParty', 'newType', 'newMode', 'newAmount'];
    inputFields.forEach(id => {
        const input = document.getElementById(id);
        if (input) {
            // Clear all potentially blocking properties
            input.disabled = false;
            input.readOnly = false;
            input.removeAttribute('disabled');
            input.removeAttribute('readonly');
            input.style.cssText = '';
            
            // Force visual reset
            input.style.pointerEvents = 'auto';
            input.style.opacity = '1';
            input.style.cursor = 'text';
            
            // Trigger browser re-registration
            input.blur();
            input.dispatchEvent(new Event('change'));
        }
    });
    
    // 3. Ensure app container is interactive
    const appContent = document.getElementById('appContent');
    if (appContent) {
        appContent.style.setProperty('pointer-events', 'auto', 'important');
        appContent.style.setProperty('filter', 'none', 'important');
        appContent.style.setProperty('opacity', '1', 'important');
        void appContent.offsetHeight;
    }
    
    // 4. Focus first input to verify it works
    setTimeout(() => {
        const firstInput = document.getElementById('newBill');
        if (firstInput) {
            firstInput.focus();
            console.log('Input reactivation complete, focused:', document.activeElement.id);
        }
    }, 50);
}

// Charts Logic
function renderCharts(data) {
    const ctxSales = document.getElementById('salesChart').getContext('2d');
    const ctxExps = document.getElementById('expenseChart').getContext('2d');

    // Destroy old instances
    if (salesChartInstance) salesChartInstance.destroy();
    if (expenseChartInstance) expenseChartInstance.destroy();

    // Create Gradients
    const salesGradient = ctxSales.createLinearGradient(0, 0, 0, 400);
    salesGradient.addColorStop(0, '#4F46E5'); // Deep Indigo
    salesGradient.addColorStop(1, '#818CF8'); // Light Indigo

    salesChartInstance = new Chart(ctxSales, {
        type: 'bar',
        data: {
            labels: ['Today', 'This Month'],
            datasets: [{
                label: 'Sales',
                data: [data.sales_today, data.sales_month],
                backgroundColor: salesGradient,
                borderRadius: 8,
                barPercentage: 0.6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, grid: { color: '#F3F4F6' } },
                x: { grid: { display: false } }
            },
            plugins: { legend: { display: false } }
        }
    });

    const expensesGradient = ctxExps.createLinearGradient(0, 0, 0, 400);
    expensesGradient.addColorStop(0, '#10B981'); // Emerald
    expensesGradient.addColorStop(1, '#34D399');

    expenseChartInstance = new Chart(ctxExps, {
        type: 'doughnut',
        data: {
            labels: ['Cash', 'Bank'],
            datasets: [{
                data: [data.cash_balance, data.bank_balance],
                backgroundColor: [expensesGradient, '#F59E0B'],
                borderWidth: 0,
                hoverOffset: 12
            }]
        },
        options: {
            responsive: true,
            cutout: '70%',
            plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, padding: 20 } } }
        }
    });
}

async function showDashboard() {
    showView('dashboardView');
    const res = await fetch("http://127.0.0.1:8000/report/dashboard");
    const data = await res.json();

    document.getElementById("dashSalesToday").innerText = data.sales_today.toFixed(2);
    document.getElementById("dashSalesMonth").innerText = data.sales_month.toFixed(2);
    document.getElementById("dashCash").innerText = data.cash_balance.toFixed(2);
    document.getElementById("dashBank").innerText = data.bank_balance.toFixed(2);
    document.getElementById("dashReceivables").innerText = data.receivables.toFixed(2);

    // Call Chart Render
    renderCharts(data);
}

function isViewActive(viewId) {
    const view = document.getElementById(viewId);
    return !!(view && view.classList.contains('active'));
}

async function updateDashboard() {
    try {
        const res = await fetch("http://127.0.0.1:8000/report/dashboard");
        const data = await res.json();

        const salesToday = document.getElementById("dashSalesToday");
        const salesMonth = document.getElementById("dashSalesMonth");
        const cash = document.getElementById("dashCash");
        const bank = document.getElementById("dashBank");
        const receivables = document.getElementById("dashReceivables");

        if (salesToday) salesToday.innerText = Number(data.sales_today || 0).toFixed(2);
        if (salesMonth) salesMonth.innerText = Number(data.sales_month || 0).toFixed(2);
        if (cash) cash.innerText = Number(data.cash_balance || 0).toFixed(2);
        if (bank) bank.innerText = Number(data.bank_balance || 0).toFixed(2);
        if (receivables) receivables.innerText = Number(data.receivables || 0).toFixed(2);

        const salesCanvas = document.getElementById('salesChart');
        const expenseCanvas = document.getElementById('expenseChart');
        if (salesCanvas && expenseCanvas) {
            renderCharts(data);
        }
    } catch (e) {
        console.error('updateDashboard failed:', e);
    }
}

// Search Filter
function filterTable(tableId, query, isTbody = false) {
    const filter = query.toUpperCase();
    const table = document.getElementById(tableId);
    let tr = table.getElementsByTagName("tr");

    // If ID is tbody directly
    if (isTbody) {
        tr = document.getElementById(tableId).getElementsByTagName("tr");
    }

    for (let i = 0; i < tr.length; i++) {
        // Skip header if it's a full table
        if (!isTbody && tr[i].parentNode.nodeName === "THEAD") continue;
        if (tr[i].parentNode.nodeName === "TFOOT") continue;

        let visible = false;
        const tds = tr[i].getElementsByTagName("td");
        for (let j = 0; j < tds.length; j++) {
            if (tds[j]) {
                const txtValue = tds[j].textContent || tds[j].innerText;
                if (txtValue.toUpperCase().indexOf(filter) > -1) {
                    visible = true;
                    break;
                }
            }
        }
        tr[i].style.display = visible ? "" : "none";
    }
}

// Toast Notifications
function showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = type === "success" ? `<ion-icon name="checkmark-circle"></ion-icon> ${message}` :
        type === "error" ? `<ion-icon name="alert-circle"></ion-icon> ${message}` : message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = "fadeOut 0.3s ease-out forwards";
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function formatMoney(value) {
    const num = Number(value || 0);
    return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateShort(dateStr) {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return dateStr;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    return `${dd}-${mm}-${yyyy}`;
}

// Dark Mode
function toggleDarkMode() {
    const isDark = document.getElementById("darkModeToggle").checked;
    if (isDark) {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('theme', 'dark');
    } else {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('theme', 'light');
    }
}

// Initialize Theme
window.onload = function () {
    initApiBase().then(() => {
        checkAuth();
        // Load essential data after auth check
        if (sessionStorage.getItem('username')) {
            loadParties();
            loadTransactions();
        }
    });
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.getElementById("darkModeToggle").checked = true;
    }
    
    // Failsafe: periodically check if modals are blocking the app
    setInterval(() => {
        if (sessionStorage.getItem('username')) {
            const editModal = document.getElementById('editTxnModal');
            const confirmModal = document.getElementById('confirmDeleteModal');
            const appContent = document.getElementById('appContent');
            
            // If modals are not shown but somehow blocking
            if (editModal) {
                const computedDisplay = window.getComputedStyle(editModal).display;
                if (computedDisplay !== 'flex' && computedDisplay !== 'block') {
                    editModal.style.pointerEvents = 'none';
                    editModal.style.visibility = 'hidden';
                }
            }
            
            if (confirmModal) {
                const computedDisplay = window.getComputedStyle(confirmModal).display;
                if (computedDisplay !== 'flex' && computedDisplay !== 'block') {
                    confirmModal.style.pointerEvents = 'none';
                    confirmModal.style.visibility = 'hidden';
                }
            }
            
            // Ensure app content is always interactive when logged in
            if (appContent && window.getComputedStyle(appContent).pointerEvents === 'none') {
                appContent.style.pointerEvents = 'auto';
                appContent.style.filter = 'none';
                console.warn('Failsafe: restored app interactivity');
            }
        }
    }, 1000); // Check every second
}

// Other Reports (Keeping existing logic mostly same but adding Error Handling)
async function showDailySummary() {
    showView('dailySummaryView');
    const res = await fetch("http://127.0.0.1:8000/report/daily-summary");
    const data = await res.json();
    const tbody = document.getElementById("dailySummaryBody");
    tbody.innerHTML = "";

    if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="text-right">No Data</td></tr>`;
        return;
    }

    data.forEach(row => {
        let cashInHandCell = `<span>${formatMoney(row.closing_cash)}</span>`;
        if (currentRole === 'admin') {
            const inputVal = row.cash_in_hand === null || row.cash_in_hand === undefined ? '' : row.cash_in_hand;
            cashInHandCell = `
                <div style="display:flex; gap:6px; align-items:center; justify-content:flex-end;">
                    <input type="number" id="cashInHand-${row.date}" value="${inputVal}" style="width:120px; text-align:right;">
                    <button class="btn-sm" style="background:#4b5563; padding: 4px 8px; font-size: 12px; color:white; border:none; border-radius:4px; cursor:pointer;" onclick="saveCashInHand('${row.date}')">Save</button>
                </div>`;
        }

        const shortExcess = Number(row.cash_short_excess || 0);
        const shortExcessColor = shortExcess < 0 ? "var(--danger)" : shortExcess > 0 ? "var(--success)" : "inherit";

        tbody.innerHTML += `
            <tr>
                <td>${formatDateShort(row.date)}</td>
                <td class="text-right">${formatMoney(row.opening_cash)}</td>
                <td class="text-right">${formatMoney(row.cash_in)}</td>
                <td class="text-right">${formatMoney(row.cash_expense)}</td>
                <td class="text-right">${formatMoney(row.cash_needed)}</td>
                <td class="text-right">${cashInHandCell}</td>
                <td class="text-right" style="color:${shortExcessColor};">${formatMoney(row.cash_short_excess)}</td>
                <td class="text-right">${formatMoney(row.bank)}</td>
                <td class="text-right">${formatMoney(row.credit_sale)}</td>
                <td class="text-right">${formatMoney(row.total_sales)}</td>
            </tr>`;
    });
}

function showDayBook() {
    showView('dayBookView');
}

async function loadDayBook() {
    const dateInput = document.getElementById('dayBookDate');
    const date = dateInput ? dateInput.value : '';
    if (!date) return showToast('Select a date', 'error');

    try {
        const res = await fetch(`http://127.0.0.1:8000/transactions/by-date?date=${encodeURIComponent(date)}`);
        if (res.status === 404) {
            await loadDayBookFallback(date);
            return;
        }

        const data = await res.json();
        renderDayBookRows(data);
    } catch (e) {
        showToast('Error loading day book: ' + e, 'error');
    }
}

async function loadDayBookFallback(date) {
    const tbody = document.getElementById('dayBookBody');
    tbody.innerHTML = '';

    let page = 1;
    let totalPages = 1;
    const limit = 1000;
    const results = [];

    while (page <= totalPages) {
        const res = await fetch(`http://127.0.0.1:8000/transactions?page=${page}&limit=${limit}`);
        const response = await res.json();
        const rows = response.transactions || [];
        totalPages = response.total_pages || 1;

        rows.forEach(row => {
            if (row.date === date) {
                results.push(row);
            }
        });

        page += 1;
    }

    renderDayBookRows(results);
}

function renderDayBookRows(rows) {
    const tbody = document.getElementById('dayBookBody');
    tbody.innerHTML = '';

    rows.forEach(row => {
        tbody.innerHTML += `
        <tr>
            <td>${formatDateShort(row.date)}</td>
            <td>${row.bill_no || ''}</td>
            <td>${row.party}</td>
            <td>${row.type}</td>
            <td>${row.mode}</td>
            <td class="text-right">${Number(row.amount).toFixed(2)}</td>
        </tr>`;
    });
}

function exportDayBook() {
    const date = document.getElementById('dayBookDate').value;
    if (!date) return showToast('Select a date to export', 'error');
    exportTableToExcel('dayBookTable', `DayBook_${date}`, `DayBook_${date}`);
}

async function showShortReport() {
    showView('shortReportView');
    const res = await fetch("http://127.0.0.1:8000/report/short-excess");
    const data = await res.json();
    const tbody = document.getElementById("shortReportBody");
    const summaryDiv = document.getElementById("shortReportSummary");
    tbody.innerHTML = "";
    if (summaryDiv) summaryDiv.innerHTML = "";

    if (!data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-right">No Data</td></tr>`;
        return;
    }

    let totalShort = 0;
    const monthAgg = {};
    data.forEach(row => {
        const shortExcess = Number(row.cash_short_excess || 0);
        const shortExcessColor = shortExcess < 0 ? "var(--danger)" : shortExcess > 0 ? "var(--success)" : "inherit";
        const cashInHand = row.cash_in_hand === null || row.cash_in_hand === undefined ? 0 : row.cash_in_hand;

        if (shortExcess < 0) totalShort += shortExcess;

        const monthKey = row.date ? row.date.slice(0, 7) : "";
        if (monthKey) {
            if (!monthAgg[monthKey]) monthAgg[monthKey] = { short: 0, excess: 0 };
            if (shortExcess < 0) monthAgg[monthKey].short += shortExcess;
            if (shortExcess > 0) monthAgg[monthKey].excess += shortExcess;
        }

        tbody.innerHTML += `
            <tr>
                <td>${formatDateShort(row.date)}</td>
                <td class="text-right">${formatMoney(row.opening_cash)}</td>
                <td class="text-right">${formatMoney(row.cash_in)}</td>
                <td class="text-right">${formatMoney(row.cash_expense)}</td>
                <td class="text-right">${formatMoney(row.cash_needed)}</td>
                <td class="text-right">${formatMoney(cashInHand)}</td>
                <td class="text-right" style="color:${shortExcessColor};">${formatMoney(row.cash_short_excess)}</td>
            </tr>`;
    });

    if (totalShort !== 0) {
        tbody.innerHTML += `
            <tr style="font-weight:bold;">
                <td>Total Short</td>
                <td class="text-right"></td>
                <td class="text-right"></td>
                <td class="text-right"></td>
                <td class="text-right"></td>
                <td class="text-right"></td>
                <td class="text-right" style="color: var(--danger);">${formatMoney(totalShort)}</td>
            </tr>`;
    }

    if (summaryDiv) {
        const months = Object.keys(monthAgg).sort().reverse();
        if (months.length) {
            let html = `
                <h3 style="margin: 16px 0 8px;">Monthly Short / Excess</h3>
                <table>
                    <thead>
                        <tr>
                            <th>Month</th>
                            <th class="text-right">Total Short</th>
                            <th class="text-right">Total Excess</th>
                            <th class="text-right">Net</th>
                        </tr>
                    </thead>
                    <tbody>`;
            months.forEach(m => {
                const shortVal = monthAgg[m].short;
                const excessVal = monthAgg[m].excess;
                const netVal = shortVal + excessVal;
                const netColor = netVal < 0 ? "var(--danger)" : netVal > 0 ? "var(--success)" : "inherit";
                html += `
                    <tr>
                        <td>${m}</td>
                        <td class="text-right" style="color: var(--danger);">${formatMoney(shortVal)}</td>
                        <td class="text-right" style="color: var(--success);">${formatMoney(excessVal)}</td>
                        <td class="text-right" style="color:${netColor};">${formatMoney(netVal)}</td>
                    </tr>`;
            });
            html += `</tbody></table>`;
            summaryDiv.innerHTML = html;
        }
    }
}

async function saveCashInHand(dateStr) {
    const input = document.getElementById(`cashInHand-${dateStr}`);
    if (!input) return;
    const val = parseFloat(input.value);
    if (Number.isNaN(val)) {
        showToast("Enter valid Cash In Hand", "error");
        return;
    }

    try {
        const res = await fetch("http://127.0.0.1:8000/cash/hand", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                date: dateStr,
                cash_in_hand: val,
                admin_user: sessionStorage.getItem("username")
            })
        });
        const data = await res.json();
        if (data.status === "Saved") {
            showToast("Cash In Hand saved", "success");
            showDailySummary();
        } else {
            showToast("Save failed: " + data.detail, "error");
        }
    } catch (e) {
        showToast("Error: " + e, "error");
    }
}

async function showModeReport(mode) {
    showView('modeReportView');
    document.getElementById("modeTitle").innerText = `${mode} Ledger`;
    const res = await fetch(`http://127.0.0.1:8000/report/mode/${mode}`);
    const data = await res.json();
    const tbody = document.getElementById("modeReportBody");
    tbody.innerHTML = "";
    data.forEach(row => {
        tbody.innerHTML += `<tr><td>${formatDateShort(row.date)}</td><td>${row.party}</td><td>${row.type}</td><td class="text-right">${row.amount.toFixed(2)}</td></tr>`;
    });
}

async function showExpenseReport() {
    showView('expenseReportView');
    const res = await fetch("http://127.0.0.1:8000/report/type/Expense");
    const data = await res.json();
    const tbody = document.getElementById("expenseReportBody");
    tbody.innerHTML = "";
    data.forEach(row => {
        tbody.innerHTML += `<tr><td>${formatDateShort(row.date)}</td><td>${row.party}</td><td>${row.mode}</td><td class="text-right">${row.amount.toFixed(2)}</td></tr>`;
    });
}

async function showOutstanding() {
    showView('outstandingView');
    const res = await fetch("http://127.0.0.1:8000/report/outstanding");
    const result = await res.json();
    const tbody = document.getElementById("outstandingBody");
    const totalSpan = document.getElementById("totalOutstanding");
    
    tbody.innerHTML = "";
    result.data.forEach(row => {
        tbody.innerHTML += `<tr><td>${row.party}</td><td class="text-right">${row.balance.toFixed(2)}</td></tr>`;
    });
    
    totalSpan.textContent = `₹${result.total.toFixed(2)}`;
}

async function showTrialBalance() {
    showView('trialBalanceView');
    const res = await fetch("http://127.0.0.1:8000/report/trial-balance");
    const data = await res.json();
    const tbody = document.getElementById("trialBalanceBody");
    tbody.innerHTML = "";
    let tD = 0, tC = 0;
    data.forEach(row => {
        tD += row.debit; tC += row.credit;
        tbody.innerHTML += `<tr><td>${row.account}</td><td>${row.debit.toFixed(2)}</td><td>${row.credit.toFixed(2)}</td></tr>`;
    });
    tbody.innerHTML += `<tr style="font-weight:bold"><td>TOTAL</td><td>${tD.toFixed(2)}</td><td>${tC.toFixed(2)}</td></tr>`;
}

async function showPnL() {
    showView('pnlView');
    const res = await fetch("http://127.0.0.1:8000/report/pnl");
    const data = await res.json();
    document.getElementById("pnlSales").innerText = data.sales.toFixed(2);
    document.getElementById("pnlExpenses").innerText = data.expenses.toFixed(2);
    document.getElementById("pnlProfit").innerText = data.net_profit.toFixed(2);
    document.getElementById("pnlProfit").style.color = data.net_profit >= 0 ? "var(--success)" : "var(--danger)";
}

// Backup & Import
async function backupDB() {
    try {
        const res = await fetch(`http://127.0.0.1:8000/backup`, { method: "POST" });
        const data = await res.json();
        if (data.status === "Backup Successful") {
            if (data.warning) {
                showToast("Backup saved on server: " + data.path, "success");
                showToast(data.warning, "error");
            } else {
                showToast("Backup created: " + data.path, "success");
            }
        } else {
            showToast("Backup Failed: " + data.detail, "error");
        }
    } catch (e) { showToast("Error: " + e, "error"); }
}

async function restoreDB() {
    const path = await ipcRenderer.invoke('dialog:openBackup');
    if (!path) return;
    if (!confirm("WARNING: This will overwrite the current database. Continue?")) return;
    try {
        const res = await fetch(`http://127.0.0.1:8000/restore?path=${encodeURIComponent(path)}`, { method: "POST" });
        const data = await res.json();
        if (data.status === "Restore Successful") {
            showToast("Restore Successful. Restarting...", "success");
            location.reload();
        } else showToast("Restore Failed: " + data.detail, "error");
    } catch (e) { showToast("Error: " + e, "error"); }
}

async function installServerMode() {
    try {
        const res = await ipcRenderer.invoke('server:install');
        if (res.success) {
            showToast('Server mode installed. Backend will start on boot.', 'success');
        } else {
            showToast('Install failed: ' + res.error, 'error');
        }
    } catch (e) {
        showToast('Install failed: ' + e.message, 'error');
    }
}

async function uninstallServerMode() {
    try {
        const res = await ipcRenderer.invoke('server:uninstall');
        if (res.success) {
            showToast('Server mode removed.', 'success');
        } else {
            showToast('Uninstall failed: ' + res.error, 'error');
        }
    } catch (e) {
        showToast('Uninstall failed: ' + e.message, 'error');
    }
}

async function restartBackend() {
    try {
        const res = await ipcRenderer.invoke('server:restart');
        if (res.success) {
            showToast('Backend restarted.', 'success');
            setTimeout(() => location.reload(), 500);
        } else {
            showToast('Restart failed: ' + res.error, 'error');
        }
    } catch (e) {
        showToast('Restart failed: ' + e.message, 'error');
    }
}

async function stopBackend() {
    try {
        const res = await ipcRenderer.invoke('server:stop');
        if (res.success) {
            showToast('Backend stopped.', 'success');
        } else {
            showToast('Stop failed: ' + res.error, 'error');
        }
    } catch (e) {
        showToast('Stop failed: ' + e.message, 'error');
    }
}

async function importData() {
    const fileInput = document.getElementById("importFile");
    if (!fileInput.files.length) return showToast("Select a file", "error");
    
    showToast("Importing... Please wait", "info");
    
    const formData = new FormData();
    formData.append("file", fileInput.files[0]);
    try {
        const res = await fetch("http://127.0.0.1:8000/import", { method: "POST", body: formData });
        const data = await res.json();
        
        if (data.status === "Imported" || data.status === "Import Successful") {
            // Show summary
            if (data.errors > 0) {
                showImportResultModal(data);
            } else {
                showToast(`✓ Import Complete: ${data.success} rows imported`, "success");
            }
            
            // Reload transactions
            loadTransactions();
            loadParties();
        } else {
            showToast("Import Failed: " + data.detail, "error");
        }
    } catch (e) { 
        showToast("Error: " + e, "error"); 
    }
}

function showImportResultModal(data) {
    const modal = document.createElement('div');
    modal.id = 'importResultModal';
    modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:3000; display:flex; justify-content:center; align-items:center;';
    
    const content = document.createElement('div');
    content.style.cssText = 'background:white; padding:30px; border-radius:12px; max-width:600px; max-height:80vh; overflow-y:auto; box-shadow:0 10px 25px rgba(0,0,0,0.2);';
    
    let failedRowsHTML = '';
    if (data.failed_rows && data.failed_rows.length > 0) {
        const displayRows = data.failed_rows.slice(0, 20);
        failedRowsHTML = '<div style="margin-top:15px; padding:15px; background:#fef2f2; border-radius:8px; max-height:300px; overflow-y:auto;">';
        failedRowsHTML += '<h4 style="margin:0 0 10px 0; color:#dc2626;">Failed Rows:</h4>';
        failedRowsHTML += '<ul style="margin:0; padding-left:20px; font-size:13px;">';
        displayRows.forEach(fail => {
            failedRowsHTML += `<li style="margin:5px 0;"><strong>Line ${fail.row}:</strong> ${fail.reason}</li>`;
        });
        failedRowsHTML += '</ul>';
        if (data.failed_rows.length > 20) {
            failedRowsHTML += `<p style="margin:10px 0 0 0; font-size:12px; color:#666;">... and ${data.failed_rows.length - 20} more failed rows</p>`;
        }
        failedRowsHTML += '</div>';
    }
    
    content.innerHTML = `
        <h3 style="margin:0 0 15px 0;">Import Results</h3>
        <div style="display:flex; gap:20px; margin-bottom:20px;">
            <div style="flex:1; padding:15px; background:#dcfce7; border-radius:8px; text-align:center;">
                <div style="font-size:32px; font-weight:bold; color:#16a34a;">${data.success || 0}</div>
                <div style="font-size:13px; color:#166534; margin-top:5px;">✓ Imported Successfully</div>
            </div>
            <div style="flex:1; padding:15px; background:#fee2e2; border-radius:8px; text-align:center;">
                <div style="font-size:32px; font-weight:bold; color:#dc2626;">${data.errors || 0}</div>
                <div style="font-size:13px; color:#991b1b; margin-top:5px;">✗ Failed to Import</div>
            </div>
        </div>
        ${failedRowsHTML}
        <button onclick="document.getElementById('importResultModal').remove()" style="width:100%; margin-top:20px; padding:12px; background:#4f46e5; color:white; border:none; border-radius:8px; cursor:pointer; font-size:14px; font-weight:600;">
            Close
        </button>
    `;
    
    modal.appendChild(content);
    document.body.appendChild(modal);
}

// Export to Excel
async function exportTableToExcel(tableId, filename = '', sheetName = 'Report') {
    try {
        const table = document.getElementById(tableId);
        if (!table) return showToast("Table not found to export", "error");

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.table_to_sheet(table);

        // Sanitize sheet name
        const safeSheetName = (sheetName || "Report").replace(/[\/\\\?\*\[\]]/g, "_").substring(0, 31);
        XLSX.utils.book_append_sheet(wb, ws, safeSheetName);

        const defaultName = filename ? filename + '.xlsx' : 'report.xlsx';

        // Ask Main Process for Save Path
        const filePath = await ipcRenderer.invoke('dialog:save', defaultName);
        if (!filePath) return; // User canceled

        XLSX.writeFile(wb, filePath);
        showToast("Export Saved!", "success");
    } catch (e) {
        showToast("Export Failed: " + e.message, "error");
    }
}

function exportLedger() {
    const party = document.getElementById("reportParty").value;
    if (!party) return showToast("Select a party to export", "error");

    // Use party name for both filename and sheet name
    const cleanName = party.trim();
    exportTableToExcel('ledgerTable', cleanName, cleanName);
}

// Keyboard Shortcuts
document.addEventListener('keydown', (e) => {
    // Alt + N: New Entry (Focus Date)
    if (e.altKey && e.key === 'n') {
        e.preventDefault();
        showView('entryView');
        activateNav(document.querySelector('a[onclick*="entryView"]'));
        document.getElementById('newDate').focus();
    }
    // Alt + L: Ledger
    if (e.altKey && e.key === 'l') {
        e.preventDefault();
        showView('ledgerView');
        activateNav(document.querySelector('a[onclick*="ledgerView"]'));
        document.getElementById('reportParty').focus();
    }
    // Alt + D: Dashboard
    if (e.altKey && e.key === 'd') {
        e.preventDefault();
        showDashboard();
        activateNav(document.querySelector('a[onclick*="showDashboard"]'));
    }
    // Ctrl + K: Focus Search (Transaction Search)
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const activeSearch = document.querySelector('.view-section.active input[placeholder*="Search"]');
        if (activeSearch) activeSearch.focus();
    }
});

// --- Authentication & Admin Logic ---

let currentUser = null;
let autoBackupTimer = null;

function checkAuth() {
    currentUser = sessionStorage.getItem('username');
    currentRole = sessionStorage.getItem('role');
    const company = sessionStorage.getItem('company');

    const modal = document.getElementById('loginModal');
    const appContent = document.getElementById('appContent');

    if (!currentUser) {
        // Show Login
        modal.style.display = 'flex';
        appContent.style.filter = 'blur(5px)';
        appContent.style.pointerEvents = 'none';
        loadCompanies();
        return;
    }

    // Hide Login & Show App
    modal.style.display = 'none';
    appContent.style.filter = 'none';
    appContent.style.pointerEvents = 'auto';

    if (company) {
        fetch('http://127.0.0.1:8000/company/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: company })
        });
    }

    startAutoBackup();
    updatePermissions();
    
    // Load essential data when already authenticated
    loadParties();
}

function startAutoBackup() {
    if (autoBackupTimer) return;
    autoBackupTimer = setInterval(() => {
        fetch('http://127.0.0.1:8000/backup/auto', { method: 'POST' });
    }, 60 * 60 * 1000);
}

async function loadCompanies(retries = 5) {
    const select = document.getElementById('loginCompany');
    if (!select) return;
    if (!select.innerHTML) {
        select.innerHTML = '<option value="">Loading companies...</option>';
    }
    try {
        const res = await fetch('http://127.0.0.1:8000/companies');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        select.innerHTML = '';
        if (!data.length) {
            select.innerHTML = '<option value="">No companies found</option>';
            return;
        }
        data.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.name;
            opt.textContent = c.name;
            select.appendChild(opt);
        });
    } catch (e) {
        if (retries > 0) {
            setTimeout(() => loadCompanies(retries - 1), 1000);
        } else {
            select.innerHTML = '<option value="">Failed to load companies</option>';
            showToast('Error loading companies', 'error');
        }
    }
}

async function createCompany() {
    const name = document.getElementById('newCompanyName').value.trim();
    if (!name) return showToast('Enter company name', 'error');
    try {
        const res = await fetch('http://127.0.0.1:8000/companies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.status === 'Created') {
            showToast('Company created', 'success');
            document.getElementById('newCompanyName').value = '';
            await loadCompanies();
            const select = document.getElementById('loginCompany');
            if (select) select.value = name;
        } else {
            showToast('Create failed: ' + data.detail, 'error');
        }
    } catch (e) {
        showToast('Error: ' + e, 'error');
    }
}

// UI Interaction for Login Inputs
async function handleLogin() {
    const user = document.getElementById('loginUser').value;
    const pass = document.getElementById('loginPass').value;
    const errorP = document.getElementById('loginError');
    const company = document.getElementById('loginCompany').value;

    if (!user || !pass || !company) {
        errorP.innerText = "Select company and enter credentials";
        return;
    }

    try {
        await fetch('http://127.0.0.1:8000/company/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: company })
        });

        const res = await fetch('http://127.0.0.1:8000/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass })
        });

        if (!res.ok) throw new Error('Invalid Username or Password');

        const data = await res.json();
        sessionStorage.setItem('username', data.username);
        sessionStorage.setItem('role', data.role);
        sessionStorage.setItem('company', company);

        checkAuth();
        showToast(`Hey ${data.username}, great to see you again! 😄`, "success");


        loadParties();
        showDashboard();

    } catch (e) {
        errorP.innerText = e.message;
    }
}

function resetLogin() {
    document.getElementById('loginStep1').classList.remove('hidden');
    document.getElementById('loginStep2').classList.remove('active');
    document.getElementById('loginPass').value = '';
    document.getElementById('loginUser').focus();
}

async function handleLogin() {
    const user = document.getElementById('loginUser').value;
    const pass = document.getElementById('loginPass').value;
    const errorP = document.getElementById('loginError2');
    const passInp = document.getElementById('loginPass');
    const company = document.getElementById('loginCompany').value;

    try {
        if (!company) throw new Error('Select company');
        await fetch('http://127.0.0.1:8000/company/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: company })
        });

        const res = await fetch('http://127.0.0.1:8000/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass })
        });

        if (!res.ok) throw new Error('Incorrect password');

        const data = await res.json();
        sessionStorage.setItem('username', data.username);
        sessionStorage.setItem('role', data.role);
        sessionStorage.setItem('company', company);

        checkAuth();
        showToast(`Hey ${data.username}, great to see you again! 😄`, "success");


        // Load initial data
        loadParties();
        
        // Load transactions AND show dashboard
        loadTransactions();
        showDashboard();

    } catch (e) {
        passInp.classList.add('shake');
        errorP.innerText = "Incorrect password/ID";
        errorP.classList.add('visible');
        setTimeout(() => passInp.classList.remove('shake'), 500);
    }
}

function handleLogout() {
    sessionStorage.clear();
    location.reload();
}

function updatePermissions() {
    // Admin Panel Visibility
    const adminPanel = document.getElementById('adminPanel');
    const renameCard = document.getElementById('renamePartyCard');

    if (currentRole === 'admin') {
        adminPanel.style.display = 'block';
        if (renameCard) renameCard.style.display = 'block';
        loadUsers();
        loadAuditLog();
        loadOpeningCashSeed();
    } else {
        adminPanel.style.display = 'none';
        if (renameCard) renameCard.style.display = 'none';
    }

    // Hide sensitive buttons for non-admins (e.g. Delete Party, specific edits)
    // For now, we mainly hide the admin panel. 
    // If there were "Edit" buttons in tables, we'd hide them here.
}

async function loadOpeningCashSeed() {
    try {
        const res = await fetch("http://127.0.0.1:8000/settings/opening-cash");
        const data = await res.json();
        const inp = document.getElementById("openingCashSeed");
        if (inp) inp.value = data.opening_cash ?? 0;
    } catch (e) {
        showToast("Error loading opening cash", "error");
    }
}

async function saveOpeningCashSeed() {
    const inp = document.getElementById("openingCashSeed");
    if (!inp) return;
    const val = parseFloat(inp.value);
    if (Number.isNaN(val)) {
        showToast("Enter valid opening cash", "error");
        return;
    }

    try {
        const res = await fetch("http://127.0.0.1:8000/settings/opening-cash", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                amount: val,
                admin_user: sessionStorage.getItem("username")
            })
        });
        const data = await res.json();
        if (data.status === "Saved") {
            showToast("Opening cash saved", "success");
            showDailySummary();
        } else {
            showToast("Save failed: " + data.detail, "error");
        }
    } catch (e) {
        showToast("Error: " + e, "error");
    }
}

// --- Admin Functions ---

async function renameParty() {
    const oldName = document.getElementById('renameOldName').value;
    const newName = document.getElementById('renameNewName').value;
    const adminUser = sessionStorage.getItem('username');

    if (!oldName || !newName) return showToast("Enter both names", "error");
    if (!confirm(`Are you sure you want to rename "${oldName}" to "${newName}"? This will affect all historical records.`)) return;

    try {
        const res = await fetch('http://127.0.0.1:8000/party/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ old_name: oldName, new_name: newName, admin_user: adminUser })
        });
        const data = await res.json();
        if (data.status === "Renamed Successfully") {
            showToast("Party Renamed!", "success");
            loadParties(); // Refresh lists
            document.getElementById('renameOldName').value = '';
            document.getElementById('renameNewName').value = '';
        } else {
            showToast("Rename Failed: " + data.detail, "error");
        }
    } catch (e) { showToast(e.message, "error"); }
}

async function createUser() {
    const u = document.getElementById('newUsername').value;
    const p = document.getElementById('newPassword').value;
    const r = document.getElementById('newRole').value;

    if (!u || !p) return showToast("Enter username & password", "error");

    try {
        const res = await fetch('http://127.0.0.1:8000/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p, role: r })
        });
        const data = await res.json();
        if (data.status === "User Created") {
            showToast("User Created", "success");
            loadUsers();
            document.getElementById('newUsername').value = '';
            document.getElementById('newPassword').value = '';
        } else {
            showToast(data.detail, "error");
        }
    } catch (e) { showToast(e.message, "error"); }
}

async function loadUsers() {
    const tbody = document.getElementById('usersTableBody');
    tbody.innerHTML = 'Loading...';
    try {
        const res = await fetch('http://127.0.0.1:8000/users');
        const users = await res.json();
        tbody.innerHTML = '';
        users.forEach(u => {
            tbody.innerHTML += `
            <tr>
                <td>${u.username}</td>
                <td>${u.role}</td>
                <td>
                    ${u.username !== 'admin' ? `<button class="secondary" style="background:#EF4444; color:white; padding:4px 8px; font-size:12px;" onclick="deleteUser('${u.username}')">Delete</button>` : 'NA'}
                </td>
            </tr>`;
        });
    } catch (e) { tbody.innerHTML = 'Error'; }
}

async function changeUserPassword() {
    const username = document.getElementById('pwdUsername').value.trim();
    const newPassword = document.getElementById('pwdNew').value;
    const adminUser = sessionStorage.getItem('username');

    if (!username || !newPassword) return showToast("Enter username & new password", "error");

    try {
        const res = await fetch('http://127.0.0.1:8000/users/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, new_password: newPassword, admin_user: adminUser })
        });
        const data = await res.json();
        if (data.status === "Password Updated") {
            showToast("Password updated", "success");
            document.getElementById('pwdUsername').value = '';
            document.getElementById('pwdNew').value = '';
        } else {
            showToast("Update failed: " + data.detail, "error");
        }
    } catch (e) {
        showToast("Error: " + e, "error");
    }
}

async function deleteUser(username) {
    if (!confirm("Are you sure?")) return;
    try {
        const res = await fetch(`http://127.0.0.1:8000/users/${username}`, { method: 'DELETE' });
        loadUsers();
    } catch (e) { showToast("Error deleting", "error"); }
}

async function loadAuditLog() {
    const tbody = document.getElementById('auditTableBody');
    try {
        const res = await fetch('http://127.0.0.1:8000/audit');
        const logs = await res.json();
        tbody.innerHTML = '';
        logs.forEach(l => {
            tbody.innerHTML += `
            <tr>
                <td>${new Date(l.timestamp).toLocaleString()}</td>
                <td>${l.username}</td>
                <td>${l.action}</td>
                <td>${l.details}</td>
            </tr>`;
        });
    } catch (e) { console.error(e); }
}

// Database Configuration Functions (continued)
async function loadDbConfig() {
    try {
        const localCfg = await loadClientConfig();
        document.getElementById('cfgApiBase').value = localCfg.api_base || apiBase;

        const res = await fetch('http://127.0.0.1:8000/config/database', { signal: AbortSignal.timeout(2000) });
        const config = await res.json();
        document.getElementById('cfgServer').value = config.server || '';
        document.getElementById('cfgDatabase').value = config.database || '';
        document.getElementById('cfgAuthType').value = config.auth_type || 'windows';
        document.getElementById('cfgUsername').value = config.username || '';
        document.getElementById('cfgBackupDir').value = config.backup_dir || '';
        toggleSqlAuth();
    } catch (e) {
        console.error('Backend not available, using defaults:', e);
        // Load defaults when backend is not running
        const localCfg = await loadClientConfig();
        document.getElementById('cfgServer').value = 'localhost';
        document.getElementById('cfgDatabase').value = 'M_Finlogs_Accounts';
        document.getElementById('cfgAuthType').value = 'windows';
        document.getElementById('cfgBackupDir').value = '';
        document.getElementById('cfgApiBase').value = localCfg.api_base || apiBase;
        toggleSqlAuth();
    }
}

async function testDbConnection() {
    const status = document.getElementById('dbConfigStatus');
    status.textContent = 'Testing connection...';
    status.style.color = '#FFA500';
    
    const server = document.getElementById('cfgServer').value.trim();
    const database = document.getElementById('cfgDatabase').value.trim();
    
    if (!server || !database) {
        status.textContent = '✗ Please enter server and database name';
        status.style.color = '#FF6B6B';
        return;
    }
    
    const config = {
        server: server,
        database: database,
        auth_type: document.getElementById('cfgAuthType').value,
        username: document.getElementById('cfgUsername').value.trim(),
        password: document.getElementById('cfgPassword').value,
        backup_dir: document.getElementById('cfgBackupDir').value.trim(),
        api_base: document.getElementById('cfgApiBase').value.trim()
    };
    
    try {
        const res = await fetch('http://127.0.0.1:8000/config/database/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        const result = await res.json();
        
        if (result.success) {
            status.textContent = '✓ Connection successful!';
            status.style.color = '#4CAF50';
        } else {
            status.textContent = '✗ Connection failed: ' + result.error;
            status.style.color = '#FF6B6B';
        }
    } catch (e) {
        status.textContent = '✗ Backend not running. Save config and restart app to test.';
        status.style.color = '#FFA500';
    }
}

async function saveDbConfig() {
    const status = document.getElementById('dbConfigStatus');
    
    const server = document.getElementById('cfgServer').value.trim();
    const database = document.getElementById('cfgDatabase').value.trim();
    
    if (!server || !database) {
        status.textContent = '✗ Please enter server and database name';
        status.style.color = '#FF6B6B';
        return;
    }
    
    const authType = document.getElementById('cfgAuthType').value;
    const username = document.getElementById('cfgUsername').value.trim();
    const password = document.getElementById('cfgPassword').value;
    
    if (authType === 'sql' && (!username || !password)) {
        status.textContent = '✗ Please enter SQL username and password';
        status.style.color = '#FF6B6B';
        return;
    }
    
    status.textContent = 'Saving configuration...';
    status.style.color = '#FFA500';
    
    const config = {
        server: server,
        database: database,
        auth_type: authType,
        username: username,
        password: password,
        backup_dir: document.getElementById('cfgBackupDir').value.trim(),
        api_base: document.getElementById('cfgApiBase').value.trim()
    };

    // Save client-side config first
    try {
        await saveClientConfig(config);
        if (config.api_base) {
            apiBase = normalizeApiBase(config.api_base);
        }
    } catch (e) {
        console.error('Failed to save client config:', e);
    }
    
    try {
        const res = await fetch('http://127.0.0.1:8000/config/database', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        const result = await res.json();
        
        if (result.success) {
            status.textContent = '✓ Configuration saved! Please restart the application.';
            status.style.color = '#4CAF50';
            setTimeout(() => {
                closeDbConfig();
                alert('Database configuration saved. Please restart the application for changes to take effect.');
            }, 2000);
        } else {
            status.textContent = '✗ Save failed: ' + result.error;
            status.style.color = '#FF6B6B';
        }
    } catch (e) {
        // Backend not available - use Node.js fs to write config directly
        console.log('Backend not available, using direct file write');
        status.textContent = 'Backend offline. Saving directly to config file...';
        status.style.color = '#FFA500';
        
        try {
            await saveClientConfig(config);
            if (config.api_base) {
                apiBase = normalizeApiBase(config.api_base);
            }
            
            status.textContent = '✓ Configuration saved! Please restart the application.';
            status.style.color = '#4CAF50';
            setTimeout(() => {
                closeDbConfig();
                alert('Database configuration saved. Please close and restart the application.');
            }, 2000);
        } catch (fsError) {
            status.textContent = '✗ Failed to save: ' + fsError.message;
            status.style.color = '#FF6B6B';
        }    }
}

// Expose DB config functions globally for inline handlers
window.testDbConnection = testDbConnection;
window.saveDbConfig = saveDbConfig;