/**
 * 使用原生 HTML table 渲染数据表格
 * @param {string} containerId - 容器元素ID
 * @param {string} tableId - 表格元素ID
 * @param {Array} data - 要显示的数据
 */
export function renderTable(containerId, tableId, data) {
  const container = document.getElementById(containerId);
  const table = document.getElementById(tableId);
  
  // 清理旧表格内容
  if (table) {
    table.innerHTML = "";
  }
  
  if (!data || data.length === 0) {
    if (container) container.style.display = "none";
    return;
  }
  
  // 显示数据容器
  if (container) {
    container.style.display = "block";
    container.style.overflowX = "auto";
    container.style.overflowY = "auto";
    container.style.maxHeight = "500px";
    container.style.position = "relative";
  }
  
  // 创建表头
  const thead = document.createElement("thead");
  thead.className = "ant-table-thead";
  
  const headerRow = document.createElement("tr");
  const columns = Object.keys(data[0]);
  
  columns.forEach(col => {
    const th = document.createElement("th");
    // 格式化列名：移除 __c, Order_, 替换下划线为空格
    th.textContent = col.replace(/__c/g, '').replace(/Order_/g, '').replace(/_/g, ' ');
    th.style.whiteSpace = "nowrap";
    th.style.overflow = "hidden";
    th.style.textOverflow = "ellipsis";
    headerRow.appendChild(th);
  });
  
  thead.appendChild(headerRow);
  
  // 创建表体
  const tbody = document.createElement("tbody");
  tbody.className = "ant-table-tbody";
  
  // 限制显示行数
  const maxRows = 1000;
  const displayData = data.slice(0, maxRows);
  
  displayData.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    tr.style.cursor = "default";
    
    // 斑马纹
    if (rowIndex % 2 === 1) {
      tr.style.backgroundColor = "#fafafa";
    }
    
    columns.forEach(col => {
      const td = document.createElement("td");
      const value = row[col];
      td.textContent = value !== null && value !== undefined ? value : "";
      td.style.maxWidth = "300px";
      td.style.overflow = "hidden";
      td.style.textOverflow = "ellipsis";
      td.style.whiteSpace = "nowrap";
      tr.appendChild(td);
    });
    
    tbody.appendChild(tr);
  });
  
  // 组装表格
  table.appendChild(thead);
  table.appendChild(tbody);
  
  // 添加溢出容器样式到 table
  table.className = "ant-table ant-table-bordered ant-table-default";
  table.style.tableLayout = "auto";
  // 使用 min-width 替代 width，确保表格在列过多时产生横向滚动
  table.style.minWidth = "100%";
  table.style.width = "auto";
}

/**
 * 使用原生 HTML table 渲染数据表格（通用版本）
 * @param {HTMLElement|string} container - 容器元素或ID
 * @param {HTMLElement|string} table - 表格元素或ID
 * @param {Array} data - 要显示的数据
 */
export function renderHtmlTable(container, table, data) {
  // 获取元素
  const containerEl = typeof container === 'string' ? document.getElementById(container) : container;
  const tableEl = typeof table === 'string' ? document.getElementById(table) : table;
  
  if (!tableEl) return;
  
  // 清理旧表格内容
  tableEl.innerHTML = "";
  
  if (!data || data.length === 0) {
    if (containerEl) containerEl.style.display = "none";
    return;
  }
  
  // 显示数据容器
  if (containerEl) {
    containerEl.style.display = "block";
    containerEl.style.overflowX = "auto";
    containerEl.style.overflowY = "auto";
    containerEl.style.maxHeight = "500px";
    containerEl.style.position = "relative";
  }
  
  // 创建表头
  const thead = document.createElement("thead");
  thead.className = "ant-table-thead";
  
  const headerRow = document.createElement("tr");
  const columns = Object.keys(data[0]);
  
  columns.forEach(col => {
    const th = document.createElement("th");
    th.textContent = col;
    th.style.whiteSpace = "nowrap";
    th.style.overflow = "hidden";
    th.style.textOverflow = "ellipsis";
    headerRow.appendChild(th);
  });
  
  thead.appendChild(headerRow);
  
  // 创建表体
  const tbody = document.createElement("tbody");
  tbody.className = "ant-table-tbody";
  
  // 限制显示行数
  const maxRows = 1000;
  const displayData = data.slice(0, maxRows);
  
  displayData.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    
    // 斑马纹
    if (rowIndex % 2 === 1) {
      tr.style.backgroundColor = "#fafafa";
    }
    
    columns.forEach(col => {
      const td = document.createElement("td");
      const value = row[col];
      td.textContent = value !== null && value !== undefined ? value : "";
      td.style.maxWidth = "300px";
      td.style.overflow = "hidden";
      td.style.textOverflow = "ellipsis";
      td.style.whiteSpace = "nowrap";
      tr.appendChild(td);
    });
    
    tbody.appendChild(tr);
  });
  
  // 组装表格
  tableEl.appendChild(thead);
  tableEl.appendChild(tbody);
  
  // 添加样式
  tableEl.className = "ant-table ant-table-bordered ant-table-default";
  tableEl.style.tableLayout = "auto";
  // 使用 min-width 替代 width，确保表格在列过多时产生横向滚动
  tableEl.style.minWidth = "100%";
  tableEl.style.width = "auto";
}
