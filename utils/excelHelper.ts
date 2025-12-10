
import * as XLSX from 'xlsx';
import { ProcessedData, Stage1Status, Stage1Row } from '../types';

/**
 * 讀取 Excel 檔案
 * 使用 ArrayBuffer 讀取以確保最佳相容性
 * 若遇到舊版 .xls 特定 Record 解析錯誤，提示使用者轉檔
 */
export const readExcelFile = (file: File): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        if (!data || !(data instanceof ArrayBuffer)) {
             throw new Error("File read failed (not ArrayBuffer)");
        }

        // 使用 type: 'array' 讀取 ArrayBuffer
        // 移除 codepage 設定以避免在無 cpexcel 支援下報錯
        const workbook = XLSX.read(data, { 
          type: 'array',
          cellFormula: false, 
          cellHTML: false
        });

        if (!workbook.SheetNames.length) throw new Error("Excel file is empty");
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(sheet));
      } catch (err: any) {
        console.error("Excel Parsing Error:", err);
        
        // 針對舊版 .xls 常見的解析錯誤 (如 Record 0x27d) 給予明確指引
        if (err.message && (err.message.includes("Record") || err.message.includes("0x"))) {
            reject("無法讀取此舊版 Excel (.xls) 格式。請將檔案另存為 .xlsx 格式後再試一次。");
        } else {
            reject(`讀取失敗: ${err.message || "未知錯誤"}`);
        }
      }
    };

    reader.onerror = (err) => {
      reject("檔案讀取錯誤");
    };
    
    reader.readAsArrayBuffer(file);
  });
};

const safeVal = (val: any) => (val === undefined || val === null) ? "" : val;
const sanitizeSheetName = (name: string): string => name.replace(/[\[\]\:\*\?\/\\\\]/g, '_').substring(0, 31) || "Unknown";

export const exportToExcel = async (processedData: ProcessedData, defaultFilename: string, selectedPersons: Set<string>) => {
  let fileHandle: any = null;
  const filename = defaultFilename.trim().replace(/\.xlsx$/i, '') + '.xlsx';
  
  if ('showSaveFilePicker' in window) {
    try {
      fileHandle = await (window as any).showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: 'Excel File',
          accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] }
        }],
      });
    } catch (err: any) {
      if (err.name === 'AbortError') return; 
    }
  }

  const workbook = XLSX.utils.book_new();
  const repurchaseMap: Record<string, { rows: Stage1Row[], totalPoints: number }> = {};
  const sortedPersons = Object.keys(processedData).sort();

  sortedPersons.forEach((person) => {
    if (!selectedPersons.has(person)) return;

    const data = processedData[person];
    // Skip NO_BONUS (though logic usually filters them before this)
    if (data.role === 'NO_BONUS') return;

    const wsData: any[][] = [];

    // --- STAGE 1 ---
    // Update: Include Repurchase points in the total (calculated points are already halved)
    const s1Total = data.stage1.reduce((sum, row) => {
      if (row.status === Stage1Status.DEVELOP || row.status === Stage1Status.HALF_YEAR || row.status === Stage1Status.REPURCHASE) {
        return sum + row.calculatedPoints;
      }
      return sum;
    }, 0);

    wsData.push([`【第一階段：點數表】 ${s1Total}點`]);
    
    // Header Row
    if (data.role === 'PHARMACIST') {
      wsData.push(["分類", "日期", "客戶編號", "品項編號", "品名", "數量", "備註", "點數"]);
    } else {
      wsData.push(["分類", "日期", "客戶編號", "品項編號", "品名", "數量", "備註", "計算點數"]);
    }
    
    data.stage1.forEach(row => {
      if (row.status === Stage1Status.DELETE) return;
      
      if (row.status === Stage1Status.REPURCHASE) {
        // Both Roles send Repurchase to summary sheet
        if (!repurchaseMap[person]) {
          repurchaseMap[person] = { rows: [], totalPoints: 0 };
        }
        repurchaseMap[person].rows.push(row);
        repurchaseMap[person].totalPoints += row.calculatedPoints;
      } else {
        // Active Rows (Develop, HalfYear)
        if (data.role === 'PHARMACIST') {
          // Pharmacist Export Rules
          // If '調劑點數', Note is empty. Else Note is Status.
          const note = row.category === '調劑點數' ? '' : row.status;
          wsData.push([
            safeVal(row.category), 
            safeVal(row.date), 
            safeVal(row.customerID),
            safeVal(row.itemID), 
            safeVal(row.itemName), 
            safeVal(row.quantity),
            safeVal(note), 
            safeVal(row.calculatedPoints)
          ]);
        } else {
          // Sales Export Rules
          const pointsVal = row.category === '現金-小兒銷售' ? '' : row.calculatedPoints;
          wsData.push([
            safeVal(row.category), 
            safeVal(row.date), 
            safeVal(row.customerID),
            safeVal(row.itemID), 
            safeVal(row.itemName), 
            safeVal(row.quantity),
            safeVal(row.status), // Sales uses status as note
            safeVal(pointsVal)
          ]);
        }
      }
    });

    wsData.push([], []);

    // --- STAGE 2 ---
    if (data.role === 'PHARMACIST') {
        // Pharmacist Stage 2 Export
        wsData.push([`【第二階段：當月調劑件數】`]);
        // Updated Header: "產品編號" -> "品項編號"
        wsData.push(["品項編號", "品名", "數量"]);
        data.stage2.forEach(row => {
             const label = row.itemID === '001727' ? '件' : '組';
             wsData.push([
                safeVal(row.itemID),
                safeVal(row.itemName),
                `${safeVal(row.quantity)}${label}`
             ]);
        });
    } else {
        // Sales Stage 2 Export
        const s2Totals = data.stage2.reduce((acc, row) => {
            if (row.isDeleted) return acc;
            if (row.format === '禮券') acc.vouchers += row.quantity;
            else {
                const amount = row.customReward !== undefined ? row.customReward : (row.quantity * row.reward);
                acc.cash += amount;
            }
            return acc;
        }, { cash: 0, vouchers: 0 });

        wsData.push([`【第二階段：現金獎勵表】 現金$${s2Totals.cash.toLocaleString()} 禮券${s2Totals.vouchers}張`]);
        wsData.push(["類別", "日期", "客戶編號", "品項編號", "品名", "數量", "備註", "獎勵"]);
        
        data.stage2.forEach(row => {
            if (row.isDeleted) return;
            let rewardDisplay = "";
            if (row.format === '禮券') {
                rewardDisplay = `${row.quantity}張${safeVal(row.rewardLabel)}`;
            } else {
                const amount = row.customReward !== undefined ? row.customReward : (row.quantity * row.reward);
                rewardDisplay = `${amount}元`;
            }
            wsData.push([
                safeVal(row.category), safeVal(row.displayDate), safeVal(row.customerID),
                safeVal(row.itemID), safeVal(row.itemName), safeVal(row.quantity),
                safeVal(row.note), safeVal(rewardDisplay)
            ]);
        });
    }

    wsData.push([], []);

    // --- STAGE 3 ---
    // Only export Stage 3 for Sales (Non-Pharmacist)
    if (data.role !== 'PHARMACIST') {
      wsData.push(["【第三階段：美妝金額】"]);
      wsData.push(["品牌分類", "金額"]);
      
      data.stage3.rows.forEach(row => wsData.push([safeVal(row.categoryName), safeVal(row.subTotal)]));
      wsData.push(["總金額", safeVal(data.stage3.total)]);
    }

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    
    // Set Column Widths
    ws['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 25 }, { wch: 8 }, { wch: 20 }, { wch: 15 }];

    let sheetName = sanitizeSheetName(person);
    let count = 1;
    const baseName = sheetName;
    while (workbook.SheetNames.includes(sheetName)) {
      sheetName = `${baseName.substring(0, 28)}(${count++})`;
    }
    XLSX.utils.book_append_sheet(workbook, ws, sheetName);
  });

  // --- REPURCHASE SUMMARY SHEET ---
  const repPersons = Object.keys(repurchaseMap).sort();
  if (repPersons.length > 0) {
    const repData: any[][] = [];
    repPersons.forEach(person => {
        const group = repurchaseMap[person];
        repData.push([`${person}    回購：${group.totalPoints}`]);
        repData.push(["分類", "日期", "客戶編號", "品項編號", "品名", "數量", "計算點數"]);
        group.rows.forEach(row => {
            repData.push([
                safeVal(row.category), safeVal(row.date), safeVal(row.customerID),
                safeVal(row.itemID), safeVal(row.itemName), safeVal(row.quantity),
                safeVal(row.calculatedPoints)
            ]);
        });
        repData.push([]); 
    });

    const wsRep = XLSX.utils.aoa_to_sheet(repData);
    wsRep['!cols'] = [{ wch: 25 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 25 }, { wch: 8 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(workbook, wsRep, "回購總表");
  }

  // 3. WRITE TO FILE
  if (fileHandle) {
    const writable = await fileHandle.createWritable();
    const wbout = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    await writable.write(new Blob([wbout], { type: 'application/octet-stream' }));
    await writable.close();
  } else {
    XLSX.writeFile(workbook, filename);
  }
};
