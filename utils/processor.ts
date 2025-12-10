
import { RawRow, ExclusionItem, RewardRule, Stage1Row, Stage2Row, Stage3Summary, Stage1Status, Stage3Row, StaffRole } from '../types';
import { COL_HEADERS, CAT_MAPPING, COSMETIC_CODES, STAGE1_SORT_ORDER, COSMETIC_DISPLAY_ORDER } from '../constants';
import { v4 as uuidv4 } from 'uuid';

// Helper: Safely get values
const getVal = (row: RawRow, key: string): any => row[key];
const getStr = (row: RawRow, key: string): string => String(row[key] || '').trim();
const getNum = (row: RawRow, key: string): number => Number(row[key]) || 0;

// --- STAGE 1: Points Table (Dispatcher) ---
export const processStage1 = (rawData: RawRow[], exclusionList: ExclusionItem[], role: StaffRole): Stage1Row[] => {
  if (role === 'PHARMACIST') {
    return processStage1Pharmacist(rawData, exclusionList);
  }
  return processStage1Sales(rawData, exclusionList);
};

// Logic for Sales Person (Store)
const processStage1Sales = (rawData: RawRow[], exclusionList: ExclusionItem[]): Stage1Row[] => {
  // New Rule: Exclude ONLY if in list AND category is "調劑點數"
  const dispensingItemIDs = new Set(
    exclusionList
      .filter(item => item.category === '調劑點數')
      .map(i => String(i.itemID).trim())
  );

  const processed: Stage1Row[] = [];

  for (const row of rawData) {
    const cid = getVal(row, COL_HEADERS.CUSTOMER_ID);
    if (!cid || cid === 'undefined') continue;

    // Sales Rule: No Debt
    if (getNum(row, COL_HEADERS.DEBT) > 0) continue;
    
    const points = getNum(row, COL_HEADERS.POINTS) || getNum(row, '點數');
    if (points === 0) continue;

    if (getNum(row, COL_HEADERS.UNIT_PRICE) === 0) continue;

    const cat1 = getStr(row, COL_HEADERS.CAT_1);
    const unit = getStr(row, COL_HEADERS.UNIT);
    if (cat1 === '05-2' && (unit === '罐' || unit === '瓶')) continue;

    const itemID = getStr(row, COL_HEADERS.ITEM_ID);
    if (dispensingItemIDs.has(itemID)) continue;

    // Transformation
    const rawPoints = points;
    const qty = getNum(row, COL_HEADERS.QUANTITY);
    
    // Determine Category
    let category = CAT_MAPPING[cat1] || '其他';
    
    const itemName = getVal(row, COL_HEADERS.ITEM_NAME) || getVal(row, '品名') || '';

    // Special Rule: 05-3 with specific keywords
    if (cat1 === '05-3') {
      const nameStr = String(itemName);
      if (nameStr.includes('麥精') || nameStr.includes('米精')) {
        category = '嬰幼兒米麥精';
      }
    }
    
    // Points Calc
    let calculatedPoints = 0;

    // Special Rule: '現金-小兒銷售' points are not calculated (set to 0 for logic, handled as empty string in UI)
    if (category === '現金-小兒銷售') {
        calculatedPoints = 0;
    } else {
        const isDividedByQty = category === '成人奶粉' || category === '成人奶水' || category === '嬰幼兒米麥精';
        calculatedPoints = isDividedByQty ? Math.floor(rawPoints / (qty || 1)) : rawPoints;
    }

    // Date parsing
    const ticketNo = getStr(row, COL_HEADERS.TICKET_NO);
    const dateStr = ticketNo.length >= 7 ? ticketNo.substring(5, 7) : '??';
    
    processed.push({
      id: uuidv4(),
      salesPerson: String(getVal(row, COL_HEADERS.SALES_PERSON) || 'Unknown'),
      date: dateStr,
      customerID: cid,
      customerName: getVal(row, COL_HEADERS.CUSTOMER_NAME),
      itemID,
      itemName,
      quantity: qty,
      originalPoints: rawPoints,
      calculatedPoints,
      category,
      status: Stage1Status.DEVELOP,
      raw: row
    });
  }
  return sortStage1(processed);
};

// Logic for Pharmacist (New Rules)
const processStage1Pharmacist = (rawData: RawRow[], exclusionList: ExclusionItem[]): Stage1Row[] => {
  // Map for fast lookup of pharmacist point list
  const pharmListMap = new Map<string, string>(); // ItemID -> Category (其他 or 調劑點數)
  exclusionList.forEach(i => pharmListMap.set(String(i.itemID).trim(), i.category));

  const processed: Stage1Row[] = [];

  for (const row of rawData) {
    const cid = getVal(row, COL_HEADERS.CUSTOMER_ID);
    if (!cid || cid === 'undefined') continue;

    // 2. Points must not be 0
    const points = getNum(row, COL_HEADERS.POINTS) || getNum(row, '點數');
    if (points === 0) continue;

    // 3. Debt must not be > 0 (Debt must be <= 0)
    if (getNum(row, COL_HEADERS.DEBT) > 0) continue;

    const itemID = getStr(row, COL_HEADERS.ITEM_ID);
    const cat1 = getStr(row, COL_HEADERS.CAT_1);
    const qty = getNum(row, COL_HEADERS.QUANTITY);
    const itemName = getVal(row, COL_HEADERS.ITEM_NAME) || getVal(row, '品名') || '';
    const ticketNo = getStr(row, COL_HEADERS.TICKET_NO);
    const dateStr = ticketNo.length >= 7 ? ticketNo.substring(5, 7) : '??';
    
    let isMatch = false;
    let category = '';
    let calculatedPoints = points;

    // 4. Check for Adult Milk Powder (05-1)
    if (cat1 === '05-1') {
      isMatch = true;
      category = '成人奶粉';
      calculatedPoints = Math.floor(points / (qty || 1));
    }
    // 5. Check Pharmacist Point List
    else if (pharmListMap.has(itemID)) {
      const listCat = pharmListMap.get(itemID);
      if (listCat === '調劑點數') {
        isMatch = true;
        category = '調劑點數';
        calculatedPoints = points;
      } else {
        // Assume '其他' or anything else maps to '其他'
        isMatch = true;
        category = '其他';
        calculatedPoints = points;
      }
    }

    if (isMatch) {
      processed.push({
        id: uuidv4(),
        salesPerson: String(getVal(row, COL_HEADERS.SALES_PERSON) || 'Unknown'),
        date: dateStr,
        customerID: cid,
        customerName: getVal(row, COL_HEADERS.CUSTOMER_NAME),
        itemID,
        itemName,
        quantity: qty,
        originalPoints: points,
        calculatedPoints,
        category,
        status: Stage1Status.DEVELOP,
        raw: row
      });
    }
  }

  // Sort: Adult Milk -> Other -> Dispensing, then Date
  const sortOrder: Record<string, number> = { '成人奶粉': 1, '其他': 2, '調劑點數': 3 };
  
  return processed.sort((a, b) => {
    const oa = sortOrder[a.category] ?? 99;
    const ob = sortOrder[b.category] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.date.localeCompare(b.date);
  });
};

const sortStage1 = (rows: Stage1Row[]): Stage1Row[] => {
  return rows.sort((a, b) => {
    const orderA = STAGE1_SORT_ORDER[a.category] ?? 99;
    const orderB = STAGE1_SORT_ORDER[b.category] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    return a.date.localeCompare(b.date);
  });
};

export const recalculateStage1Points = (row: Stage1Row, role: StaffRole = 'SALES'): number => {
  // 1. If status is DELETE, always return 0 immediately.
  if (row.status === Stage1Status.DELETE) return 0;

  // 2. Recover 'originalPoints' if missing (e.g. from legacy saves)
  // We use row.raw to fetch the source points.
  let base = row.originalPoints;
  if (base === undefined || base === null) {
      base = Number(row.raw?.[COL_HEADERS.POINTS] || row.raw?.['點數'] || 0);
  }

  if (role === 'PHARMACIST') {
    // Pharmacist Logic
    if (row.category === '調劑點數') return base; 
    
    if (row.category === '成人奶粉') {
       base = Math.floor(base / (row.quantity || 1));
    }
    
    if (row.status === Stage1Status.REPURCHASE) {
      return Math.floor(base / 2);
    }
    return base;
  }
  
  // Sales Logic
  
  // Rule: Cash Pediatric Sales -> 0
  if (row.category === '現金-小兒銷售') return 0;

  const isDividedByQty = row.category === '成人奶粉' || row.category === '成人奶水' || row.category === '嬰幼兒米麥精';
  
  if (isDividedByQty) {
     base = Math.floor(base / (row.quantity || 1));
  }
  
  return row.status === Stage1Status.REPURCHASE ? Math.floor(base / 2) : base;
};

// --- STAGE 2: Rewards ---
export const processStage2 = (rawData: RawRow[], rewardRules: RewardRule[], role: StaffRole = 'SALES'): Stage2Row[] => {
  if (role === 'PHARMACIST') {
    return processStage2Pharmacist(rawData);
  }
  return processStage2Sales(rawData, rewardRules);
};

const processStage2Sales = (rawData: RawRow[], rewardRules: RewardRule[]): Stage2Row[] => {
  const ruleMap = new Map(rewardRules.map(r => [String(r.itemID).trim(), r]));
  const processed: Stage2Row[] = [];

  for (const row of rawData) {
    const itemID = getStr(row, COL_HEADERS.ITEM_ID);
    const rule = ruleMap.get(itemID);
    
    if (!rule) continue;

    const cid = getVal(row, COL_HEADERS.CUSTOMER_ID);
    if (!cid || cid === 'undefined') continue;
    if (getNum(row, COL_HEADERS.UNIT_PRICE) === 0) continue;
    if (getNum(row, COL_HEADERS.DEBT) > 0) continue;

    const cat1 = getStr(row, COL_HEADERS.CAT_1);
    const unit = getStr(row, COL_HEADERS.UNIT);
    if (cat1 === '05-2' && (unit === '罐' || unit === '瓶')) continue;

    const ticketNo = getStr(row, COL_HEADERS.TICKET_NO);
    const displayDate = ticketNo.length >= 7 ? ticketNo.substring(5, 7) : '??';

    processed.push({
      id: uuidv4(),
      salesPerson: String(getVal(row, COL_HEADERS.SALES_PERSON) || 'Unknown'),
      displayDate,
      sortDate: getVal(row, COL_HEADERS.SALES_DATE),
      customerID: cid,
      customerName: getVal(row, COL_HEADERS.CUSTOMER_NAME),
      itemID,
      itemName: getVal(row, COL_HEADERS.ITEM_NAME) || getVal(row, '品名') || '',
      quantity: getNum(row, COL_HEADERS.QUANTITY),
      category: rule.category,
      note: rule.note,
      reward: rule.reward,
      rewardLabel: rule.rewardLabel,
      format: rule.format,
      isDeleted: false
    });
  }

  return processed.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.displayDate.localeCompare(b.displayDate);
  });
};

const processStage2Pharmacist = (rawData: RawRow[]): Stage2Row[] => {
  // 1. Filter ItemID "001727" -> "自費調劑"
  // 2. Filter ItemID "001345" -> "調劑藥事服務費"
  // Aggregate sum
  
  let qty1727 = 0;
  let qty1345 = 0;
  let person = 'Unknown';

  for (const row of rawData) {
    person = String(getVal(row, COL_HEADERS.SALES_PERSON) || person);
    const itemID = getStr(row, COL_HEADERS.ITEM_ID);
    const qty = getNum(row, COL_HEADERS.QUANTITY);

    if (itemID === '001727') {
      qty1727 += qty;
    } else if (itemID === '001345') {
      qty1345 += qty;
    }
  }

  const results: Stage2Row[] = [];
  
  if (qty1727 > 0) {
    results.push({
      id: uuidv4(),
      salesPerson: person,
      displayDate: '',
      sortDate: '',
      customerID: '',
      customerName: '',
      itemID: '001727',
      itemName: '自費調劑',
      quantity: qty1727,
      category: '調劑',
      note: '',
      reward: 0,
      rewardLabel: '件',
      format: '統計',
      isDeleted: false
    });
  }

  if (qty1345 > 0) {
    results.push({
      id: uuidv4(),
      salesPerson: person,
      displayDate: '',
      sortDate: '',
      customerID: '',
      customerName: '',
      itemID: '001345',
      itemName: '調劑藥事服務費',
      quantity: qty1345,
      category: '調劑',
      note: '',
      reward: 0,
      rewardLabel: '組',
      format: '統計',
      isDeleted: false
    });
  }

  return results;
};

// --- STAGE 3: Cosmetics ---
export const processStage3 = (rawData: RawRow[]): Stage3Summary[] => {
  const byPerson: Record<string, Record<string, number>> = {};

  for (const row of rawData) {
    const cat2 = getStr(row, COL_HEADERS.CAT_2);
    if (!COSMETIC_CODES[cat2]) continue;

    const person = String(getVal(row, COL_HEADERS.SALES_PERSON) || 'Unknown');
    const brandName = COSMETIC_CODES[cat2];
    const subTotal = getNum(row, COL_HEADERS.SUBTOTAL);

    if (!byPerson[person]) byPerson[person] = {};
    byPerson[person][brandName] = (byPerson[person][brandName] || 0) + subTotal;
  }

  return Object.keys(byPerson).map(person => {
    const brandTotals = byPerson[person];
    const rows = COSMETIC_DISPLAY_ORDER.map(brand => ({
      categoryName: brand,
      subTotal: brandTotals[brand] || 0
    }));
    return {
      salesPerson: person,
      rows,
      total: rows.reduce((acc, curr) => acc + curr.subTotal, 0)
    };
  });
};

export const generateEmptyStage3Rows = (): Stage3Row[] => {
  return COSMETIC_DISPLAY_ORDER.map(brand => ({ categoryName: brand, subTotal: 0 }));
};
