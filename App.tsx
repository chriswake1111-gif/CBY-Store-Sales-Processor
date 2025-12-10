
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { RawRow, ExclusionItem, RewardRule, ProcessedData, Stage1Status, StaffRole, Stage3Summary } from './types';
import { readExcelFile, exportToExcel } from './utils/excelHelper';
import { processStage1, processStage2, processStage3, recalculateStage1Points, generateEmptyStage3Rows } from './utils/processor';
import { saveToLocal, loadFromLocal, checkSavedData } from './utils/storage';
import FileUploader from './components/FileUploader';
import PopoutWindow from './components/PopoutWindow';
import DataViewer from './components/DataViewer';
import StaffClassificationModal from './components/StaffClassificationModal';
import HelpModal from './components/HelpModal';
import { Download, Maximize2, AlertCircle, MonitorDown, Save, FolderOpen, Activity, FileSpreadsheet, HelpCircle } from 'lucide-react';
import { COL_HEADERS } from './constants';

const App: React.FC = () => {
  const [exclusionList, setExclusionList] = useState<ExclusionItem[]>([]);
  const [rewardRules, setRewardRules] = useState<RewardRule[]>([]);
  const [rawSalesData, setRawSalesData] = useState<RawRow[]>([]);
  const [processedData, setProcessedData] = useState<ProcessedData>({});
  
  // New State for Staff Classification
  const [staffRoles, setStaffRoles] = useState<Record<string, StaffRole>>({});
  const [isClassifying, setIsClassifying] = useState(false);
  const [pendingRawData, setPendingRawData] = useState<RawRow[] | null>(null);
  
  const [activePerson, setActivePerson] = useState<string>('');
  const [selectedPersons, setSelectedPersons] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<'stage1' | 'stage2' | 'stage3'>('stage1');
  const [isPopOut, setIsPopOut] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const [lastSaveTime, setLastSaveTime] = useState<number | null>(null);
  const [hasSavedData, setHasSavedData] = useState<boolean>(false);
  
  // PWA States
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  
  const stateRef = useRef({ exclusionList, rewardRules, rawSalesData, processedData, activePerson, selectedPersons, staffRoles });

  useEffect(() => {
    const ts = checkSavedData();
    if (ts) { setHasSavedData(true); setLastSaveTime(ts); }

    const checkStandalone = () => {
      const isApp = window.matchMedia('(display-mode: standalone)').matches;
      setIsStandalone(isApp);
    };
    
    checkStandalone();
    window.matchMedia('(display-mode: standalone)').addEventListener('change', checkStandalone);

    const handleBeforeInstallPrompt = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
      console.log('PWA install prompt captured');
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
      console.log('PWA was installed');
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    stateRef.current = { exclusionList, rewardRules, rawSalesData, processedData, activePerson, selectedPersons, staffRoles };
  }, [exclusionList, rewardRules, rawSalesData, processedData, activePerson, selectedPersons, staffRoles]);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    console.log(`User response to the install prompt: ${outcome}`);
    setDeferredPrompt(null);
  };

  const handleManualSave = () => {
    if (stateRef.current.rawSalesData.length === 0) return alert("目前無資料可儲存");
    
    const ts = saveToLocal(stateRef.current);
    if (ts) {
        setLastSaveTime(ts);
        setHasSavedData(true);
        alert(`已儲存進度 (${new Date(ts).toLocaleTimeString()})`);
    } else {
        alert("儲存失敗，可能是瀏覽器儲存空間不足。");
    }
  };

  const handleLoadSave = () => {
    const saved = loadFromLocal();
    if (saved) {
      if (rawSalesData.length > 0 && !window.confirm("讀取存檔將覆蓋目前資料，確定要讀取嗎？")) return;
      setExclusionList(saved.exclusionList); setRewardRules(saved.rewardRules);
      setRawSalesData(saved.rawSalesData); setProcessedData(saved.processedData);
      setActivePerson(saved.activePerson); setSelectedPersons(new Set(saved.selectedPersons));
      setStaffRoles(saved.staffRoles || {});
      setLastSaveTime(saved.timestamp);
      setHasSavedData(true);
      alert(`已還原 ${new Date(saved.timestamp).toLocaleString()} 的存檔`);
    }
  };

  const handleImportExclusion = async (file: File) => {
    try {
      const json = await readExcelFile(file);
      setExclusionList(json.map((row: any) => ({ 
        itemID: String(row['品項編號'] || row['Item ID'] || Object.values(row)[0]).trim(),
        category: String(row['分類'] || row['類別'] || '').trim() 
      })));
    } catch (e) { alert("匯入失敗: " + e); }
  };

  const handleImportRewards = async (file: File) => {
    try {
      const json = await readExcelFile(file);
      setRewardRules(json.map((row: any) => ({
        itemID: String(row['品項編號']).trim(), note: row['備註'], category: row['類別'],
        reward: Number(row['獎勵金額'] || row['獎勵'] || row['金額'] || 0),
        rewardLabel: String(row['獎勵金額'] || row['獎勵'] || row['金額'] || ''),
        format: row['形式'] || '現金'
      })));
    } catch (e) { alert("匯入失敗: " + e); }
  };

  const handleImportSales = async (file: File) => {
    if (!exclusionList.length || !rewardRules.length) return alert("請先匯入藥師點數與獎勵清單！");
    
    if (rawSalesData.length > 0) {
      const confirmMsg = "即將匯入新的銷售報表。\n\n確定要執行嗎？\n\n注意：此動作將會「清除」目前所有的篩選進度與手動修改紀錄，並重新回到「人員職位設定」步驟。";
      if (!window.confirm(confirmMsg)) return;
    }

    setErrorMsg(null);
    try {
      const json = await readExcelFile(file);
      const people = new Set<string>();
      json.forEach((row: any) => {
        const p = row[COL_HEADERS.SALES_PERSON];
        if (p) people.add(String(p));
      });
      
      if (people.size === 0) return alert("找不到銷售人員資料");
      
      setRawSalesData([]); 
      setProcessedData({});
      setActivePerson('');
      setSelectedPersons(new Set());
      setPendingRawData(json);
      setIsClassifying(true);
    } catch (e) { setErrorMsg("處理失敗: " + e); }
  };

  const handleConfirmClassification = (updatedRoles: Record<string, StaffRole>) => {
    if (!pendingRawData) return;
    setStaffRoles(updatedRoles);
    setIsClassifying(false);
    
    try {
      const grouped: ProcessedData = {};
      const people = Object.keys(updatedRoles); 
      const peopleSet = new Set(people); 

      const rowsByPerson: Record<string, RawRow[]> = {};
      pendingRawData.forEach(row => {
        const p = String(row[COL_HEADERS.SALES_PERSON] || '');
        if (p && peopleSet.has(p)) {
          if (!rowsByPerson[p]) rowsByPerson[p] = [];
          rowsByPerson[p].push(row);
        }
      });

      Object.keys(rowsByPerson).forEach(person => {
        const role = updatedRoles[person] || 'SALES';
        if (role === 'NO_BONUS') return;

        const personRows = rowsByPerson[person];
        const pStage1 = processStage1(personRows, exclusionList, role);
        const pStage2 = processStage2(personRows, rewardRules, role);
        let pStage3: Stage3Summary;
        
        if (role === 'PHARMACIST') {
           pStage3 = { salesPerson: person, rows: [], total: 0 };
        } else {
           const s3Summary = processStage3(personRows);
           pStage3 = s3Summary.length > 0 ? s3Summary[0] : { salesPerson: person, rows: generateEmptyStage3Rows(), total: 0 };
        }
        
        grouped[person] = { role, stage1: pStage1, stage2: pStage2, stage3: pStage3 };
      });

      setRawSalesData(pendingRawData);
      setProcessedData(grouped);
      setSelectedPersons(new Set(Object.keys(grouped)));
      
      const sortedKeys = Object.keys(grouped).sort((a, b) => {
         const roleA = grouped[a].role;
         const roleB = grouped[b].role;
         const pA = roleA === 'SALES' ? 1 : (roleA === 'PHARMACIST' ? 2 : 3);
         const pB = roleB === 'SALES' ? 1 : (roleB === 'PHARMACIST' ? 2 : 3);
         if (pA !== pB) return pA - pB;
         return a.localeCompare(b, 'zh-TW');
      });

      if (sortedKeys.length > 0) setActivePerson(sortedKeys[0]);
      setPendingRawData(null);
      
    } catch (e) { 
      setErrorMsg("處理失敗: " + e); 
      setPendingRawData(null);
    }
  };

  const handleCancelClassification = () => {
    setIsClassifying(false);
    setPendingRawData(null);
  };

  const handleExportClick = async () => {
    if (!selectedPersons.size) return alert("請選擇銷售人員");
    const defaultFilename = `獎金計算報表_${new Date().toISOString().slice(0,10)}`;
    await exportToExcel(processedData, defaultFilename, selectedPersons);
  };

  const setPersonData = (personId: string, transform: (p: ProcessedData[string]) => ProcessedData[string]) => {
    setProcessedData(prev => {
      const personData = prev[personId];
      if (!personData) return prev;
      return {
        ...prev,
        [personId]: transform(personData)
      };
    });
  };

  const handleStatusChangeStage1 = (id: string, s: Stage1Status) => {
    if (!activePerson) return;
    setPersonData(activePerson, (data) => ({
      ...data,
      stage1: data.stage1.map(row => 
        row.id === id 
          ? { ...row, status: s, calculatedPoints: recalculateStage1Points({ ...row, status: s }, data.role) }
          : row
      )
    }));
  };

  const handleToggleDeleteStage2 = (id: string) => {
    if (!activePerson) return;
    setPersonData(activePerson, (data) => ({
      ...data,
      stage2: data.stage2.map(row => 
        row.id === id ? { ...row, isDeleted: !row.isDeleted } : row
      )
    }));
  };

  const handleUpdateStage2CustomReward = (id: string, val: string) => {
    if (!activePerson) return;
    setPersonData(activePerson, (data) => ({
      ...data,
      stage2: data.stage2.map(row => 
        row.id === id ? { ...row, customReward: val === '' ? undefined : Number(val) } : row
      )
    }));
  };

  const sortedPeople = useMemo(() => {
    return Object.keys(processedData).sort((a, b) => {
       const roleA = processedData[a].role;
       const roleB = processedData[b].role;
       const pA = roleA === 'SALES' ? 1 : (roleA === 'PHARMACIST' ? 2 : 3);
       const pB = roleB === 'SALES' ? 1 : (roleB === 'PHARMACIST' ? 2 : 3);
       if (pA !== pB) return pA - pB;
       return a.localeCompare(b, 'zh-TW');
    });
  }, [processedData]);

  const currentData = useMemo(() => activePerson ? processedData[activePerson] : null, [processedData, activePerson]);
  
  const stage1TotalPoints = useMemo(() => {
    return currentData?.stage1.reduce((sum, r) => {
      // Include REPURCHASE in the total count (they are already halved in r.calculatedPoints)
      if (r.status === Stage1Status.DEVELOP || r.status === Stage1Status.HALF_YEAR || r.status === Stage1Status.REPURCHASE) {
        return sum + r.calculatedPoints;
      }
      return sum;
    }, 0) || 0;
  }, [currentData]);

  const dvProps = {
    sortedPeople, selectedPersons, togglePersonSelection: (p: string, e: any) => { e.stopPropagation(); const s = new Set(selectedPersons); s.has(p) ? s.delete(p) : s.add(p); setSelectedPersons(s); },
    activePerson, setActivePerson, currentData, activeTab, setActiveTab, stage1TotalPoints,
    handleStatusChangeStage1, handleToggleDeleteStage2, handleUpdateStage2CustomReward, onClose: isPopOut ? () => setIsPopOut(false) : undefined
  };
  
  const classificationNames = useMemo(() => {
    if (!pendingRawData) return [];
    const s = new Set<string>();
    pendingRawData.forEach(r => {
        const p = r[COL_HEADERS.SALES_PERSON];
        if(p) s.add(String(p));
    });
    return Array.from(s).sort();
  }, [pendingRawData]);

  return (
    <>
      <div className="flex flex-col h-screen bg-slate-100 font-sans text-slate-900">
        {!isStandalone && deferredPrompt && (
          <div className="bg-slate-700 border-b border-slate-600 px-4 py-2 flex items-center justify-between text-white text-sm z-50">
             <div className="flex items-center gap-2">
               <MonitorDown size={16} />
               <span>建議安裝應用程式以獲得最佳體驗</span>
             </div>
             <button 
               onClick={handleInstallClick}
               className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded shadow-sm text-xs font-bold transition-colors"
             >
               安裝
             </button>
          </div>
        )}

        {/* Professional Header: Dark Slate */}
        <div className="bg-slate-900 border-b border-slate-700 px-6 py-3 flex justify-between items-center shrink-0 z-40 text-white shadow-md">
          <div className="flex items-center gap-3">
             <div className="p-1.5 bg-blue-600 rounded text-white shadow-sm"><Activity size={18} /></div>
             <div>
                <h1 className="text-lg font-bold tracking-wide flex items-center gap-2">
                  分店獎金計算系統 
                  <button onClick={() => setShowHelp(true)} className="text-slate-400 hover:text-white transition-colors" title="使用說明">
                    <HelpCircle size={18} />
                  </button>
                </h1>
                <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
                    <span className="px-1.5 py-0.5 bg-slate-800 border border-slate-700 rounded">v0.94</span>
                    <span className="font-sans font-light tracking-widest text-[10px] text-slate-500 opacity-80 uppercase border-l border-slate-700 pl-2">Made BY ChrisChiu</span>
                    {lastSaveTime && <span className="flex items-center gap-1 border-l border-slate-700 pl-2"><Save size={10}/> {new Date(lastSaveTime).toLocaleTimeString()}</span>}
                </div>
             </div>
          </div>
          <div className="flex gap-2">
             <button 
               onClick={handleManualSave} 
               disabled={!rawSalesData.length} 
               className="flex items-center gap-2 px-3 py-1.5 text-xs text-emerald-300 bg-slate-800 border border-emerald-800/50 hover:bg-slate-700 hover:text-emerald-200 transition-colors font-medium rounded-sm disabled:opacity-30 disabled:cursor-not-allowed"
             >
               <Save size={14}/> 儲存
             </button>
             {hasSavedData && (
                <button 
                  onClick={handleLoadSave} 
                  className="flex items-center gap-2 px-3 py-1.5 text-xs text-amber-300 bg-slate-800 border border-amber-800/50 hover:bg-slate-700 hover:text-amber-200 transition-colors font-medium rounded-sm"
                >
                  <FolderOpen size={14} /> 讀取
                </button>
             )}
             <button onClick={() => setIsPopOut(true)} disabled={!Object.keys(processedData).length} className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-300 bg-slate-800 border border-slate-700 hover:bg-slate-700 hover:text-white transition-colors font-medium rounded-sm disabled:opacity-30"><Maximize2 size={14}/> 視窗</button>
             <button onClick={handleExportClick} disabled={!Object.keys(processedData).length} className="flex items-center gap-2 px-4 py-1.5 text-xs bg-blue-700 text-white border border-blue-600 hover:bg-blue-600 hover:border-blue-500 rounded-sm disabled:bg-slate-800 disabled:border-slate-700 disabled:text-slate-600 transition-colors font-bold shadow-sm"><Download size={14} /> 匯出報表</button>
          </div>
        </div>

        {/* Input Grid: Compact & Industrial */}
        <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-3 gap-3 shrink-0 w-full border-b border-gray-200 bg-white">
            <FileUploader label="1. 藥師點數清單" onFileSelect={handleImportExclusion} isLoaded={exclusionList.length > 0} icon="list" />
            <FileUploader label="2. 現金獎勵表" onFileSelect={handleImportRewards} isLoaded={rewardRules.length > 0} icon="dollar" />
            <FileUploader label="3. 銷售報表" onFileSelect={handleImportSales} disabled={!exclusionList.length || !rewardRules.length} isLoaded={rawSalesData.length > 0} icon="file" />
        </div>

        {errorMsg && (
            <div className="mx-4 mt-2 p-2 bg-red-100 border border-red-300 text-red-800 flex items-center gap-2 text-sm font-bold">
                <AlertCircle size={16} />
                <span>{errorMsg}</span>
            </div>
        )}

        {/* Main Data View - Square, Bordered, Maximized */}
        {sortedPeople.length > 0 ? (
           <div className="flex-1 overflow-hidden p-4">
             <div className="h-full bg-white border border-slate-300 shadow-sm flex flex-col">
                <DataViewer {...dvProps} />
             </div>
           </div>
        ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-300 bg-slate-50">
                <FileSpreadsheet size={64} className="mb-4 text-slate-200" />
                <p className="text-lg font-bold text-slate-400">等待資料匯入...</p>
            </div>
        )}
      </div>
      
      {isPopOut && <PopoutWindow title="結果預覽" onClose={() => setIsPopOut(false)}><DataViewer {...dvProps} /></PopoutWindow>}
      
      {isClassifying && (
        <StaffClassificationModal 
            names={classificationNames} 
            initialRoles={staffRoles}
            onConfirm={handleConfirmClassification}
            onCancel={handleCancelClassification}
        />
      )}

      {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
    </>
  );
};
export default App;
