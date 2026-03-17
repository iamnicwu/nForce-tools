import { showNotification } from "./utils.js";

/**
 * 导出数据到 Excel
 * @param {Array} data - 要导出的数据
 * @param {string} fileNamePrefix - 文件名前缀
 * @param {string} sheetName - 工作表名称
 */
export function exportToExcel(data, fileNamePrefix, sheetName) {
  if (!data || data.length === 0) {
    showNotification("没有可导出的数据", "info");
    return;
  }

  try {
    // 使用SheetJS将数据转换为Excel文件
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);

    // 生成文件名，包含当前日期和时间
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const hours = String(today.getHours()).padStart(2, '0');
    const minutes = String(today.getMinutes()).padStart(2, '0');
    const seconds = String(today.getSeconds()).padStart(2, '0');
    const dateStr = `${year}${month}${day}_${hours}${minutes}${seconds}`;
    const fileName = `${fileNamePrefix}_${dateStr}.xlsx`;

    // 导出文件
    XLSX.writeFile(workbook, fileName);
    showNotification(`数据已成功导出为 ${fileName}`, "success");
    console.log("数据导出成功");
  } catch (error) {
    console.error("导出数据失败:", error);
    showNotification("导出数据失败，请稍后重试", "error");
  }
}

/**
 * 处理 Excel 文件上传
 * @param {File} file - 上传的文件
 * @param {Function} onSuccess - 成功回调，参数为订单号数组
 * @param {Function} onError - 失败回调，参数为错误信息
 */
export function processExcelFile(file, onSuccess, onError) {
  if (!file) return;

  if (!file.name.endsWith(".xlsx")) {
    console.error("文件格式不正确，请上传Excel文件(.xlsx)");
    showNotification("请上传Excel文件(.xlsx)", "error");
    if (onError) onError("文件格式不正确");
    return;
  }

  console.log("开始处理Excel文件:", file.name);
  showNotification("正在处理文件...", "success");

  // 使用SheetJS读取Excel文件
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      console.log("文件读取完成，开始解析Excel");
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: "array" });
      console.log(
        "Excel文件解析成功，工作表数量:",
        workbook.SheetNames.length
      );

      // 智能选择最新的工作表 (类似 Python 逻辑)
      let targetSheetName = null;
      let latestDate = null;

      // 尝试解析 "Day Month" 格式 (e.g., "10 Feb")
      const monthMap = {
        'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
        'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
      };

      workbook.SheetNames.forEach(name => {
        try {
          // 简单的正则匹配 "Day Month"
          const match = name.trim().match(/^(\d+)\s+([a-zA-Z]+)$/);
          if (match) {
            const day = parseInt(match[1], 10);
            const monthStr = match[2].toLowerCase();
            if (monthMap.hasOwnProperty(monthStr)) {
              const year = new Date().getFullYear();
              const date = new Date(year, monthMap[monthStr], day);
              
              if (!latestDate || date > latestDate) {
                latestDate = date;
                targetSheetName = name;
              }
            }
          }
        } catch (e) {
          // ignore
        }
      });

      if (targetSheetName) {
        console.log(`找到最新日期的工作表: ${targetSheetName}`);
      } else {
        // 优先查找名为 'details' 的工作表
        targetSheetName = workbook.SheetNames.find(name => name.toLowerCase() === 'details');
        
        if (!targetSheetName) {
          console.log("未找到日期格式或 'details' 工作表，使用第一个工作表");
          targetSheetName = workbook.SheetNames[0];
        }
      }

      // 获取工作表
      const worksheet = workbook.Sheets[targetSheetName];
      console.log("正在处理工作表:", targetSheetName);

      // 将工作表转换为JSON数据
      const jsonData = XLSX.utils.sheet_to_json(worksheet);
      console.log("工作表转换为JSON数据成功，行数:", jsonData.length);

      // 提取订单号
      const orderNumbers = [];
      // 可能的列名列表（小写）
      const possibleColumnNames = [
        "ordernumber",
        "order number",
        "order.ordernumber",
        "order no",
        "order_no",
        "order id",
        "order_id",
        "订单号",
        "订单编号"
      ];

      if (jsonData.length > 0) {
        // 查找订单号列
        let orderColumn = null;
        const firstRowKeys = Object.keys(jsonData[0]);
        console.log("查找订单号列，可用列:", firstRowKeys);

        // 尝试查找匹配的列
        for (const key of firstRowKeys) {
          const normalizedKey = key.toLowerCase().trim();
          // 直接匹配
          if (possibleColumnNames.includes(normalizedKey)) {
            orderColumn = key;
            break;
          }
          // 去除空格和特殊字符后匹配
          const cleanKey = normalizedKey.replace(/[^a-z0-9\u4e00-\u9fa5]/g, ""); // 保留中文
          if (possibleColumnNames.some(name => name.replace(/[^a-z0-9\u4e00-\u9fa5]/g, "") === cleanKey)) {
            orderColumn = key;
            break;
          }
        }

        if (orderColumn) {
          console.log("找到订单号列:", orderColumn);
          // 提取订单号，去重
          const uniqueOrders = new Set();
          jsonData.forEach((row) => {
            let orderNumber = row[orderColumn];
            // 确保有值，并转换为字符串
            if (orderNumber !== null && orderNumber !== undefined && orderNumber !== '') {
              // 转换为字符串并去除首尾空格
              const orderStr = String(orderNumber).trim();
              if (orderStr) {
                uniqueOrders.add(orderStr);
              }
            }
          });

          orderNumbers.push(...uniqueOrders);
          console.log(
            "提取订单号完成，共",
            orderNumbers.length,
            "个唯一订单号"
          );
          
          if (onSuccess) {
            onSuccess(orderNumbers);
          }
        } else {
          console.error("未找到订单号列，请检查Excel文件格式");
          showNotification(
            "未找到订单号列，请检查Excel文件格式",
            "error"
          );
          if (onError) onError("未找到订单号列");
          return;
        }
      } else {
        console.log("Excel文件中没有数据行");
        if (onError) onError("Excel文件中没有数据行");
      }
    } catch (error) {
      console.error("处理Excel文件时出错:", error);
      showNotification("处理Excel文件失败，请检查文件格式", "error");
      if (onError) onError(error);
    }
  };

  reader.onerror = function () {
    console.error("读取Excel文件失败");
    showNotification("读取Excel文件失败", "error");
    if (onError) onError("读取Excel文件失败");
  };

  // 开始读取文件
  console.log("开始读取文件...");
  reader.readAsArrayBuffer(file);
}

/**
 * 处理 VVIP Excel 文件上传 (解析 Account ID)
 * @param {File} file - 上传的文件
 * @param {Function} onSuccess - 成功回调，参数为 Account ID 数组
 * @param {Function} onError - 失败回调，参数为错误信息
 */
export function processVVIPExcelFile(file, onSuccess, onError) {
  if (!file) return;

  if (!file.name.endsWith(".xlsx")) {
    console.error("文件格式不正确，请上传Excel文件(.xlsx)");
    showNotification("请上传Excel文件(.xlsx)", "error");
    if (onError) onError("文件格式不正确");
    return;
  }

  console.log("开始处理VVIP Excel文件:", file.name);
  showNotification("正在处理文件...", "success");

  // 使用SheetJS读取Excel文件
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      console.log("文件读取完成，开始解析Excel");
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: "array" });
      
      const pcdIds = new Set();
      const ltsIds = new Set();
      let hasProcessedAnySheet = false;

      // 辅助函数：处理单个工作表
      const processSheet = (sheetName, possibleColumnNames, label, targetSet) => {
        if (!workbook.SheetNames.includes(sheetName)) return false;

        const worksheet = workbook.Sheets[sheetName];
        console.log(`正在处理工作表: ${sheetName}`);
        
        const jsonData = XLSX.utils.sheet_to_json(worksheet);
        console.log(`工作表 ${sheetName} 转换为JSON数据成功，行数: ${jsonData.length}`);

        if (jsonData.length === 0) return false;

        // 查找目标列
        let targetColumn = null;
        const firstRowKeys = Object.keys(jsonData[0]);
        console.log(`在 ${sheetName} 中查找 ${label} 列，可用列:`, firstRowKeys);

        // 尝试查找匹配的列
        for (const key of firstRowKeys) {
          const normalizedKey = key.toLowerCase().trim();
          // 直接匹配
          if (possibleColumnNames.includes(normalizedKey)) {
            targetColumn = key;
            break;
          }
          // 去除空格和特殊字符后匹配
          const cleanKey = normalizedKey.replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
          if (possibleColumnNames.some(name => name.replace(/[^a-z0-9\u4e00-\u9fa5]/g, "") === cleanKey)) {
            targetColumn = key;
            break;
          }
        }

        if (targetColumn) {
          console.log(`找到 ${label} 列:`, targetColumn);
          let count = 0;
          jsonData.forEach((row) => {
            let idValue = row[targetColumn];
            // 确保有值，并转换为字符串
            if (idValue !== null && idValue !== undefined && idValue !== '') {
              // 转换为字符串并去除首尾空格
              const idStr = String(idValue).trim();
              if (idStr) {
                targetSet.add(idStr);
                count++;
              }
            }
          });
          console.log(`从 ${sheetName} 提取了 ${count} 个 ${label}`);
          return true;
        } else {
          console.log(`在 ${sheetName} 中未找到 ${label} 列`);
          return false;
        }
      };

      // 1. 尝试处理 'Migrated PCD' 工作表
      if (processSheet("Migrated PCD", ["bsn"], "bsn", pcdIds)) {
        hasProcessedAnySheet = true;
      }

      // 2. 尝试处理 'Migrated LTS' 工作表
      if (processSheet("Migrated LTS", ["cust_num", "cust num", "custnum"], "CUST_NUM", ltsIds)) {
        hasProcessedAnySheet = true;
      }

      // 3. 如果没有处理任何特定的 sheet，回退到处理第一个 sheet
      if (!hasProcessedAnySheet) {
        console.log("未找到预定义的 PCD/LTS 工作表，尝试处理第一个工作表");
        const firstSheetName = workbook.SheetNames[0];
        
        // 尝试查找 bsn (PCD)
        const pcdProcessed = processSheet(firstSheetName, ["bsn"], "bsn", pcdIds);
        
        // 尝试查找 CUST_NUM (LTS)
        const ltsProcessed = processSheet(firstSheetName, ["cust_num", "cust num", "custnum"], "CUST_NUM", ltsIds);
        
        if (pcdProcessed || ltsProcessed) {
            hasProcessedAnySheet = true;
        }
      }

      const pcdIdsArray = Array.from(pcdIds);
      const ltsIdsArray = Array.from(ltsIds);
      const totalCount = pcdIdsArray.length + ltsIdsArray.length;
      
      if (totalCount > 0) {
        console.log(
          `提取完成，共 ${pcdIdsArray.length} 个 PCD ID, ${ltsIdsArray.length} 个 LTS ID`
        );
        if (onSuccess) {
          onSuccess({ pcdIds: pcdIdsArray, ltsIds: ltsIdsArray });
        }
      } else {
        console.error("未找到有效的 Account ID (bsn 或 CUST_NUM)，请检查Excel文件格式");
        showNotification(
          "未找到有效的 Account ID (bsn 或 CUST_NUM)，请检查Excel文件格式",
          "error"
        );
        if (onError) onError("未找到有效的 Account ID");
      }
    } catch (error) {
      console.error("处理Excel文件时出错:", error);
      showNotification("处理Excel文件失败，请检查文件格式", "error");
      if (onError) onError(error);
    }
  };

  reader.onerror = function () {
    console.error("读取Excel文件失败");
    showNotification("读取Excel文件失败", "error");
    if (onError) onError("读取Excel文件失败");
  };

  // 开始读取文件
  console.log("开始读取文件...");
  reader.readAsArrayBuffer(file);
}

/**
 * 分析数据
 * @param {Array} data - 要分析的数据
 * @param {Array} customRules - 自定义规则 (可选)
 * @returns {Array} - 分析后的数据
 */
export function analyzeData(data, customRules) {
  if (!data || data.length === 0) return data;

  const jsonData = [...data]; // 浅拷贝
  
  const keys = Object.keys(jsonData[0]);
  // 辅助函数：查找列名（忽略大小写和首尾空格）
  const findKey = (name) => keys.find(k => k && k.trim().toLowerCase() === name.toLowerCase());
  
  // 默认规则
  const defaultRules = [
    {
      name: "Rule 1 (Fixed)",
      conditions: [
        {
          field: "Order Status",
          operator: "in",
          value: ["Activated", "Superseded", "Cancelled"]
        }
      ],
      actions: [
        {
          field: "Issue Status",
          value: "Fixed"
        }
      ]
    },
    {
      name: "Rule 2 (RBS)",
      conditions: [
        {
          field: "Order Status",
          operator: "equals",
          value: "In Progress-Fulfilment Completed"
        }
      ],
      actions: [
        {
          field: "Issue Status",
          value: "In progress"
        },
        {
          field: "Latest Action By",
          value: "RBS"
        },
        {
          field: "Action",
          value: "RBS"
        }
      ]
    },
    {
      name: "Rule 3 (Vicki)",
      conditions: [
        {
          field: "Order Status",
          operator: "equals",
          value: "In Progress"
        },
        {
          field: "Fulfilment Status",
          operator: "equals",
          value: "Remake Appointment (M1)"
        }
      ],
      actions: [
        {
          field: "Issue Status",
          value: "Waiting for user"
        },
        {
          field: "Latest Action By",
          value: "Vicki"
        },
        {
          field: "Action",
          value: "Vicki"
        }
      ]
    },
    {
      name: "Rule 4 (Waiting for user F&S)",
      conditions: [
        {
          field: "Fulfilment Status",
          operator: "equals",
          value: "F&S Followed"
        }
      ],
      actions: [
        {
          field: "Issue Status",
          value: "Waiting for user"
        },
        {
          field: "Latest Action By",
          value: "F&S"
        }
      ]
    }
  ];

  // 使用自定义规则或默认规则
  const rulesToApply = (customRules && customRules.length > 0) ? customRules : defaultRules;
  
  return applyRules(jsonData, rulesToApply);
}

/**
 * 分析 T-2 数据
 * @param {Array} data - 要分析的数据
 * @param {Array} rules - 规则列表
 * @returns {Array} - 分析后的数据
 */
export function analyzeT2Data(data, rules) {
  if (!data || data.length === 0) return data;
  if (!rules || rules.length === 0) return data;

  const jsonData = [...data]; // 浅拷贝
  console.log("开始分析 T-2 数据...");
  console.log(jsonData);
  return applyRules(jsonData, rules);
}

/**
 * 应用规则到数据
 * @param {Array} data - 要处理的数据
 * @param {Array} rules - 规则列表
 * @returns {Array} - 处理后的数据
 */
export function applyRules(data, rules) {
  if (!data || data.length === 0 || !rules || rules.length === 0) return data;

  const jsonData = [...data]; // 浅拷贝
  const keys = Object.keys(jsonData[0]);
  // 辅助函数：查找列名（忽略大小写和首尾空格，支持 Salesforce 字段名匹配）
  const matchKey = (excelColName, ruleFieldName) => {
    if (!excelColName) return false;
    
    const s1 = excelColName.toLowerCase();
    const s2 = ruleFieldName.toLowerCase();
    
    // 1. 简单归一化 (移除空格, _, -, .)
    const n1 = s1.replace(/[\s_\-\.]/g, '');
    const n2 = s2.replace(/[\s_\-\.]/g, '');
    if (n1 === n2) return true;
    
    // 2. Salesforce 智能匹配
    // 移除常见的 Salesforce 前缀/后缀，然后再归一化比较
    const stripSF = (s) => {
        let res = s;
        res = res.replace(/__c$/, '');
        res = res.replace(/^vlocity_cmt__/, '');
        res = res.replace(/^order\./, ''); // Order.Field
        res = res.replace(/^order__/, ''); // Order__Field
        return res;
    };
    
    const cleanS1 = stripSF(s1).replace(/[\s_\-\.]/g, '');
    const cleanS2 = stripSF(s2).replace(/[\s_\-\.]/g, '');
    
    if (cleanS1 === cleanS2) return true;
    
    // 3. 包含匹配 (应对 "Order - Status" vs "Status" 或 "LOB" vs "Order LOB")
    // 只有当长度大于2时才进行包含匹配，避免误判
    if (cleanS1.length > 2 && cleanS2.length > 2) {
      if (cleanS1.endsWith(cleanS2) || cleanS2.endsWith(cleanS1)) return true;
    }

    return false;
  };

  const findKey = (name) => {
    return keys.find(k => matchKey(k, name));
  };

  // 在行数据中查找列名（用于处理动态添加的列或首行缺失的列）
  const findKeyInRow = (row, name) => {
    return Object.keys(row).find(k => matchKey(k, name));
  };

  console.log(`开始根据规则处理数据，规则数量: ${rules.length}`);

  let processedCount = 0;
  const ruleStats = {};

  // 预先查找所有涉及到的列名，避免在循环中重复查找
  const columnMap = {};
  rules.forEach(rule => {
    ruleStats[rule.name] = 0;
    
    if (rule.conditions) {
      rule.conditions.forEach(cond => {
        if (!columnMap[cond.field]) {
          columnMap[cond.field] = findKey(cond.field);
        }
      });
    }
    
    if (rule.actions) {
      rule.actions.forEach(action => {
        if (!columnMap[action.field]) {
          columnMap[action.field] = findKey(action.field);
        }
      });
    }
  });

  jsonData.forEach(row => {
    let rowUpdated = false;

    // 遍历每条规则
    for (const rule of rules) {
      // 检查条件
      const matchType = rule.match || 'all'; // 'all' (AND) or 'any' (OR)
      let conditionsMet = true;
      
      if (rule.conditions && rule.conditions.length > 0) {
        // 如果是 'any' 模式，初始状态为 false，只要有一个满足就变为 true
        if (matchType === 'any') {
          conditionsMet = false;
        }

        for (const cond of rule.conditions) {
          let thisConditionMet = true;
          let columnKey = columnMap[cond.field];
          
          // 如果缓存中未找到，尝试在当前行查找（处理动态列或首行缺失列的情况）
          if (!columnKey) {
            const foundKey = findKeyInRow(row, cond.field);
            if (foundKey) {
              columnKey = foundKey;
              columnMap[cond.field] = foundKey; // 更新缓存
            }
          }

          // 如果条件字段不存在
          if (!columnKey) {
            // 如果是检查是否为空，列不存在视为满足条件
            if (cond.operator === 'is_empty') {
              // thisConditionMet = true; // 默认就是 true
            } else {
              // 其他情况视为不满足
              thisConditionMet = false;
            }
          } else {
            let cellValue = row[columnKey];
            
            // 统一转为字符串进行处理（用于宽松比较），处理 null/undefined
            let strCellValue = '';
            if (cellValue !== null && cellValue !== undefined) {
              strCellValue = String(cellValue).trim();
            }

            // 根据操作符判断
            switch (cond.operator) {
              case 'equals':
              case '=':
                // 宽松比较：如果直接相等，或者转为字符串后相等
                if (cellValue != cond.value && strCellValue !== String(cond.value).trim()) {
                   thisConditionMet = false;
                }
                break;
              case 'in':
                if (!Array.isArray(cond.value)) {
                  thisConditionMet = false;
                } else {
                  // 1. 精确匹配
                  let isMatch = cond.value.includes(cellValue);
                  
                  // 2. 如果未匹配，尝试更宽松的匹配 (转字符串比较，忽略大小写)
                  if (!isMatch) {
                    const cellValueLower = strCellValue.toLowerCase();
                    isMatch = cond.value.some(val => {
                      if (val === null || val === undefined) return false;
                      const valStr = String(val).trim();
                      const valLower = valStr.toLowerCase();
                      
                      // 精确匹配字符串 或 忽略大小写
                      if (strCellValue === valStr || cellValueLower === valLower) return true;

                      // 特殊处理：如果规则值包含在单元格值中 (例如 "In Progress" 匹配 "In Progress - 1")
                      if (cellValueLower.includes(valLower)) return true;
                      
                      return false;
                    });
                  }
                  
                  if (!isMatch) thisConditionMet = false;
                }
                break;
              case 'not_equals':
              case '!=':
                // 宽松比较
                if (cellValue == cond.value || strCellValue === String(cond.value).trim()) {
                  thisConditionMet = false;
                }
                break;
              case 'contains':
                if (!strCellValue.includes(cond.value)) thisConditionMet = false;
                break;
              case 'contains_any':
                if (Array.isArray(cond.value)) {
                  // 检查 cellValue 是否包含数组中的任何一个值
                  const hasAny = cond.value.some(v => strCellValue.includes(v));
                  if (!hasAny) thisConditionMet = false;
                } else {
                  // 回退到普通 contains
                  if (!strCellValue.includes(cond.value)) thisConditionMet = false;
                }
                break;
              case 'not_contains':
                if (strCellValue.includes(cond.value)) thisConditionMet = false;
                break;
              case 'is_empty':
                 if (cellValue !== null && cellValue !== undefined && strCellValue !== '') thisConditionMet = false;
                 break;
              case 'is_not_empty':
                 if (cellValue === null || cellValue === undefined || strCellValue === '') thisConditionMet = false;
                 break;
              // 可以根据需要添加更多操作符
              default:
                console.warn(`未知的操作符: ${cond.operator}`);
                thisConditionMet = false;
            }
          }

          // 根据 matchType 更新 conditionsMet
          if (matchType === 'all') {
            if (!thisConditionMet) {
              conditionsMet = false;
              break; // AND 模式：只要有一个不满足，就结束
            }
          } else if (matchType === 'any') {
            if (thisConditionMet) {
              conditionsMet = true;
              break; // OR 模式：只要有一个满足，就结束
            }
          }
        }
      }

      // 如果条件满足，执行动作
      if (conditionsMet) {
        if (rule.actions && rule.actions.length > 0) {
          rule.actions.forEach(action => {
            const columnKey = columnMap[action.field];
            // 如果目标列存在，则更新；如果不存在，可以选择创建新列或者忽略
            // 这里我们假设如果列不存在，则尝试查找（可能在之前的规则中未涉及但现在需要）
            // 或者直接使用字段名作为键（如果源数据允许动态添加列）
            const targetKey = columnKey || action.field;
            
            row[targetKey] = action.value;

            // 如果是新列，更新映射，以便后续规则可以引用
            if (!columnKey) {
              columnMap[action.field] = targetKey;
            }
          });
          
          rowUpdated = true;
          ruleStats[rule.name]++;
          // 一旦匹配了一条规则，是否继续匹配其他规则？
          // 这里的逻辑是继续匹配，后面的规则可能会覆盖前面的规则
          // 如果希望匹配到一条就停止，可以加上 break;
        }
      }
    }

    if (rowUpdated) {
      processedCount++;
    }
  });

  console.log(`数据处理完成，共更新了 ${processedCount} 行数据`);
  Object.keys(ruleStats).forEach(ruleName => {
    console.log(`规则 "${ruleName}" 应用次数: ${ruleStats[ruleName]}`);
  });

  return jsonData;
}

/**
 * 处理数据分析 Excel 文件上传
 * @param {File} file - 上传的文件
 * @param {Function} onSuccess - 成功回调，参数为解析后的 JSON 数据
 * @param {Function} onError - 失败回调，参数为错误信息
 */
export function processAnalysisExcelFile(file, onSuccess, onError) {
  if (!file) return;

  if (!file.name.endsWith(".xlsx")) {
    console.error("文件格式不正确，请上传Excel文件(.xlsx)");
    showNotification("请上传Excel文件(.xlsx)", "error");
    if (onError) onError("文件格式不正确");
    return;
  }

  console.log("开始处理数据分析 Excel 文件:", file.name);
  showNotification("正在处理文件...", "success");

  // 使用SheetJS读取Excel文件
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      console.log("文件读取完成，开始解析Excel");
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: "array" });
      
      //优先查找名为 'details' 的工作表
      let targetSheetName = workbook.SheetNames.find(name => name.toLowerCase() === 'details');
      // 如果没找到，则使用第一个工作表
      if (!targetSheetName) {
        console.log("未找到名为 'details' 的工作表，使用第一个工作表");
        targetSheetName = workbook.SheetNames[0];
      }
      const worksheet = workbook.Sheets[targetSheetName];
      console.log(`正在处理工作表: ${targetSheetName}`);
      
      // 将工作表转换为JSON数据
      // defval: '' 选项确保即使单元格为空，生成的 JSON 对象也会包含该列的键（表头），从而保留完整的表头结构
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
      console.log(`工作表 ${targetSheetName} 转换为JSON数据成功，行数: ${jsonData.length}`);

      if (jsonData.length > 0) {
        if (onSuccess) {
          onSuccess(jsonData);
        }
      } else {
        console.error("Excel文件中没有数据行");
        showNotification("Excel文件中没有数据行", "error");
        if (onError) onError("Excel文件中没有数据行");
      }
    } catch (error) {
      console.error("处理Excel文件时出错:", error);
      showNotification("处理Excel文件失败，请检查文件格式", "error");
      if (onError) onError(error);
    }
  };

  reader.onerror = function () {
    console.error("读取Excel文件失败");
    showNotification("读取Excel文件失败", "error");
    if (onError) onError("读取Excel文件失败");
  };

  // 开始读取文件
  console.log("开始读取文件...");
  reader.readAsArrayBuffer(file);
}

/**
 * 读取 Excel 文件并返回 Workbook 对象
 * @param {File} file - 上传的文件
 * @returns {Promise<Object>} - Workbook 对象
 */
export function readExcelFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject("文件为空");
      return;
    }
    if (!file.name.endsWith(".xlsx")) {
      reject("文件格式不正确，请上传Excel文件(.xlsx)");
      return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        resolve(workbook);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = function () {
      reject("读取Excel文件失败");
    };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * 解析指定 Sheet 的数据
 * @param {Object} workbook - Workbook 对象
 * @param {string} sheetName - Sheet 名称
 * @returns {Array} - JSON 数据
 */
export function parseSheetData(workbook, sheetName) {
  if (!workbook || !workbook.Sheets || !workbook.Sheets[sheetName]) {
    return [];
  }
  const worksheet = workbook.Sheets[sheetName];
  // defval: '' 选项确保即使单元格为空，生成的 JSON 对象也会包含该列的键（表头）
  return XLSX.utils.sheet_to_json(worksheet, { defval: '' });
}

/**
 * 获取唯一订单号数量
 * @param {Array} data - JSON 数据
 * @returns {number} - 唯一订单号数量
 */
export function getUniqueOrderCount(data) {
  if (!data || data.length === 0) return 0;

  // 可能的列名列表（小写）
  const possibleColumnNames = [
    "ordernumber",
    "order number",
    "order.ordernumber",
    "order no",
    "order_no",
    "order id",
    "order_id",
    "订单号",
    "订单编号",
    "order_number__c" // 针对 Salesforce 字段名
  ];

  const firstRowKeys = Object.keys(data[0]);
  let orderColumn = null;

  // 尝试查找匹配的列
  for (const key of firstRowKeys) {
    const normalizedKey = key.toLowerCase().trim();
    // 直接匹配
    if (possibleColumnNames.includes(normalizedKey)) {
      orderColumn = key;
      break;
    }
    // 去除空格和特殊字符后匹配
    const cleanKey = normalizedKey.replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
    if (possibleColumnNames.some(name => name.replace(/[^a-z0-9\u4e00-\u9fa5]/g, "") === cleanKey)) {
      orderColumn = key;
      break;
    }
  }

  if (orderColumn) {
    const uniqueOrders = new Set();
    data.forEach((row) => {
      let orderNumber = row[orderColumn];
      if (orderNumber !== null && orderNumber !== undefined && orderNumber !== '') {
        const orderStr = String(orderNumber).trim();
        if (orderStr) {
          uniqueOrders.add(orderStr);
        }
      }
    });
    return uniqueOrders.size;
  }

  return 0;
}

/**
 * 应用 T2 规则 (填充 Action 列)
 * @param {Array} data - JSON 数据
 * @returns {Array} - 处理后的数据
 */
export function applyT2Rules(data) {
  if (!data || data.length === 0) return data;

  const jsonData = [...data]; // 浅拷贝

  // 辅助函数：获取列值（模糊匹配列名）
  // 优先匹配 Salesforce API Name (__c), 然后是标准名称
  const getValue = (row, ...possibleNames) => {
    const keys = Object.keys(row);
    for (const name of possibleNames) {
      // 1. 精确匹配
      let key = keys.find(k => k === name);
      if (key) return row[key];

      // 2. 忽略大小写和下划线/空格匹配
      const normalize = str => str.toLowerCase().replace(/[\s_]/g, '');
      const target = normalize(name);
      key = keys.find(k => normalize(k) === target);
      if (key) return row[key];
      
      // 3. 尝试匹配包含 __c 的情况 (Salesforce 字段)
      key = keys.find(k => normalize(k) === normalize(name + '__c'));
      if (key) return row[key];
    }
    return null;
  };

  // 辅助函数：设置列值
  const setValue = (row, colName, value) => {
    // 查找现有的 Action 列
    const keys = Object.keys(row);
    let key = keys.find(k => k.toLowerCase() === colName.toLowerCase());
    
    if (!key) {
      key = colName; // 如果不存在，使用默认名称
    }
    row[key] = value;
  };

  jsonData.forEach(row => {
    // 映射 Python 代码中的列索引到可能的列名
    // row[16]: Order Status (Order.Custom_OrderStatus__c)
    const orderStatus = getValue(row, "Order Status", "Custom_OrderStatus", "Custom_OrderStatus__c", "Order.Custom_OrderStatus__c");
    // row[17]: Fulfillment Status (Order.Custom_FulfilmentStatus__c)
    const fulfillmentStatus = getValue(row, "Fulfillment Status", "Custom_FulfilmentStatus", "Custom_FulfilmentStatus__c", "Order.Custom_FulfilmentStatus__c");
    // row[23]: Fulfillment Remark (FulfillmentRemark__c)
    const fulfillmentRemark = getValue(row, "Fulfillment Remark", "FulfillmentRemark", "FulfillmentRemark__c");
    // row[7]: Order Name (Order.Name)
    const orderName = getValue(row, "Order Name", "OrderNumber", "Name", "Order.Name");
    // row[9]: Order Nature (Order.Order_Nature__c)
    const orderNature = getValue(row, "Order Nature", "OrderNature", "OrderNature__c", "Order.Order_Nature__c");
    // row[19]: CreatedBy (Order.CreatedBy.Name)
    const createdBy = getValue(row, "Created By", "CreatedBy", "CreatedById", "Order.CreatedBy.Name");
    // row[22]: Appointment ID (AppointmentId__c)
    const appointmentId = getValue(row, "Appointment ID", "AppointmentId", "Appointment__c", "AppointmentId__c");

    const lob = getValue(row, "LOB", "LOB__c", "Order.LOB__c");
    let orderType = '';

    if (lob === "FixedLine"){
      orderType = "COM(LTS)";
    }
    else{
      orderType = "COM(PCD)";
    }

    let action = null;

    // 1. Check Order.Custom_OrderStatus__c and Order.Custom_FulfilmentStatus__c
    if (orderStatus === "Ready To Submit" && fulfillmentStatus === "In Progress") {
      action = orderType;
      if (createdBy !== "integration.user") {
        action = "Sales";
      }
    } else if (orderStatus === "Cancel Requested") {
      action = orderType;
    } else if (orderStatus === "Ready To Submit" && fulfillmentStatus === "Appointment Changed (M1)") {
      action = orderType;
    } else if (orderStatus === "Ready To Submit" && fulfillmentStatus === "Sales Support Follow-up (M3)") {
      action = orderType;
    } else if (orderStatus === "Ready To Submit" && fulfillmentStatus === "Remake Appointment (M1)") {
      action = orderType;
    } else if (orderStatus === "Amend Requested" && fulfillmentStatus === "Inventory Fallout") {
      action = orderType;
    } else if (orderStatus === "Frozen" || orderStatus === "Rejected") {
      action = orderType;
    } else if (orderStatus === "Amend Requested" && (fulfillmentStatus === "Appointment Changed (M1)" || fulfillmentStatus === "Appointment Changed (M2)")) {
      action = orderType;
    } else if (orderStatus === "In Progress" && !fulfillmentStatus) {
      action = orderType;
    } else if (fulfillmentStatus === "In Progress - Fulfillment Data Issue") {
      action = orderType;
    } else if ((fulfillmentStatus === "Appointment Changed (M1)" || fulfillmentStatus === "Appointment Changed (M2)") && !appointmentId) {
      action = orderType;
    } else if (orderStatus === "In Progress" && fulfillmentStatus === "F&S Followed") {
      action = "N/A";
    } else if (orderStatus === "In Progress" && fulfillmentStatus === "Inventory Replenishment") {
      action = "F&S";
    } else if (orderStatus === "In Progress" && fulfillmentStatus === "Address Check Sales Follow-up") {
      action = "Sales";
    } else if (orderStatus === "Ready To Submit" && !fulfillmentStatus) {
      action = "N/A";
    } else if (fulfillmentStatus === "Address Approved" || fulfillmentStatus === "Address Check SB Assigned") {
      action = "Sales";
    }

    // 2. Check FulfillmentRemark__c column
    if (!action && typeof fulfillmentRemark === 'string') {
      // Python: re.split(r'\n+(?=\[)', fulfillment_remark)
      // JS: split by newline followed by '['
      const remarks = fulfillmentRemark.split(/\n+(?=\[)/).map(s => s.trim()).filter(s => s);
      
      if (remarks.length > 0) {
        const firstRemark = remarks[0];
        
        if (firstRemark.includes("CANCELLED")) {
          action = "N/A";
        } else if (firstRemark.includes("RESOURCE USED UP")) {
          action = "F&S";
        } else if (firstRemark.includes("L2JOB FALLOUT")) {
          action = "LDAP";
        } else if (firstRemark.includes('NORA updated "ORDER ABORT"')) {
          action = "NORA";
        } else if (firstRemark.includes('updated "L2JOB ISSUED"')) {
          action = "N/A";
          if (remarks.length > 1) {
            const secondRemark = remarks[1].trim();
            if (secondRemark.includes("2N Status: Rented")) {
              action = "N/A";
            } else if (secondRemark.includes("2N Status: Failed")) {
              action = "Sales";
            } else if (secondRemark.includes("DRC: [33]")) {
              action = "N/A";
            }
          }
        }
      }
    }

    // 3. Check other conditions (scan all remarks)
    if (!action && typeof fulfillmentRemark === 'string') {
      const remarks = fulfillmentRemark.split(/\n+(?=\[)/).map(s => s.trim()).filter(s => s);
      
      for (const remark of remarks) {
        if (remark.includes("APPOINTMENT CHANGED")) {
          if (remark.includes("DRC: [31]") && orderStatus === "Amend Requested") {
            action = orderType;
            break;
          }
          if (remark.includes("DRC: [31]") && (fulfillmentStatus === "Remake Appointment (M1)" || fulfillmentStatus === "Remake Appointment (M2)")) {
            action = "Sales";
            break;
          }
          if (remark.includes("DRC: [31]") && remark.includes("TID: true")) {
            action = "Sales";
            break;
          }
          if (remark.includes("Await Sales Follow Up")) {
            action = "Sales";
            break;
          }
          if (remark.includes("DRC: [50]") && remark.includes("TID: true")) {
            action = "Sales";
            break;
          }
          if ((remark.includes("Customer Busy") || remark.includes("await customer")) && remark.includes("TID: true")) {
            action = "N/A";
            break;
          }
          if (remark.includes("DRC: [21]") || remark.includes("DRC: [22]")) {
            action = "OPS";
            break;
          }
          if (remark.includes("DRC: [68]")) {
            action = "FS";
            break;
          }
          if (remark.includes("DRC: [12]")) {
            action = "N/A";
            break;
          }
          if (remark.includes("DRC: [58]")) {
            action = "Sales";
            break;
          }
          if (remark.includes("Customer Busy") && remark.includes("TID: false")) {
            action = "N/A";
            break;
          }
        }

        if (remark.includes("2N UPDATED") && (remark.includes("2N Status: Failed") || remark.includes("SEE"))) {
          action = "FS CALL CENTER";
          break;
        }

        if (remark.includes("INVENTORY FALLOUT") || remark.includes("Fallout Reason: Cable assignment issue")) {
          if (remark.includes("OPS")) {
            action = "OPS";
            break;
          }
          if (remark.includes("ORA-01403: no data found")) {
            action = orderType;
            break;
          }
          if (remark.includes("UIM")) {
            action = "UIM";
            if (remark.includes("MANUAL ASSIGNMENT REQUIRED")) {
              action = "BAND";
            }
            break;
          }
          if (remark.includes("BAND")) {
            action = "BAND";
            break;
          }
        }

        if (remark.includes("PID FALLOUT")) {
          action = orderType;
          break;
        }
        
        if (remark.includes("RESOURCE USED UP")) {
          action = "F&S";
          break;
        }

        if (action) break;

        if (remark.includes("ORDER RECEIVED")) {
          action = "N/A";
        }
      }
    }

    // Special case for Sales action with CS order name
    if (action === "Sales" && orderName && String(orderName).startsWith("CS")) {
      action = "CS";
    }

    // Apply action
    if (action) {
      setValue(row, "Action", action);
    }
  });

  return jsonData;
}