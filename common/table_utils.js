/**
 * 使用 Handsontable 渲染数据表格
 * @param {string} containerId - 容器元素ID
 * @param {string} tableId - 表格元素ID
 * @param {Array} data - 要显示的数据
 * @param {Object} hotInstance - 当前的 Handsontable 实例（用于销毁旧实例）
 * @returns {Object} 新的 Handsontable 实例
 */
export function renderTable(containerId, tableId, data, hotInstance) {
  const container = document.getElementById(containerId);
  const table = document.getElementById(tableId);
  
  // 销毁旧实例
  if (hotInstance) {
    hotInstance.destroy();
  }
  
  if (!data || data.length === 0) {
    if (container) container.style.display = "none";
    return null;
  }
  
  // 准备Handsontable需要的数据格式
  const tableColumns = Object.keys(data[0]).map(col => ({
      title: col.replace(/__c/g, '').replace(/Order_/g, '').replace(/_/g, ' '),
      data: col
  }));
  
  // 配置Handsontable
  const hotConfig = {
    data: data,
    columns: tableColumns,
    colHeaders: true,
    rowHeaders: true,
    stretchH: 'all',
    autoWrapRow: true,
    autoWrapCol: true,
    maxRows: 1000,
    width: '100%',
    height: '500px',
    licenseKey: 'non-commercial-and-evaluation',
    filters: true,
    dropdownMenu: true,
    sortIndicator: true,
    manualColumnResize: true,
    manualRowResize: true,
    manualColumnMove: true,
    search: true,
    contextMenu: {
        items: {
            'row_above': {
                name: '在上方插入行'
            },
            'row_below': {
                name: '在下方插入行'
            },
            'col_left': {
                name: '在左侧插入列'
            },
            'col_right': {
                name: '在右侧插入列'
            },
            'remove_row': {
                name: '删除行'
            },
            'remove_col': {
                name: '删除列'
            },
            '---------': '---------',
            'copy': {
                name: '复制'
            },
            'cut': {
                name: '剪切'
            },
            'paste': {
                name: '粘贴'
            }
        }
    }
  };
  
  // 创建Handsontable实例
  const newHotInstance = new Handsontable(table, hotConfig);
  
  // 显示数据容器
  if (container) container.style.display = "block";
  
  return newHotInstance;
}