import type { Locale } from '../landing/messages';
const entry = (
  zh: string,
  tw: string,
  en: string,
  es: string
): Record<Locale, string> => ({ 'zh-CN': zh, 'zh-TW': tw, en, es });
export const uiMessages = {
  'ui.optionsSearch': entry(
    '搜索选项',
    '搜尋選項',
    'Find an option',
    'Buscar una opción'
  ),
  'ui.optionsEmpty': entry(
    '没有匹配选项',
    '沒有符合的選項',
    'No matching options',
    'No hay opciones coincidentes'
  ),
  'ui.notifications': entry(
    '操作通知',
    '操作通知',
    'Notifications',
    'Notificaciones'
  ),
  'ui.notificationsCount': entry(
    '{count} 条通知',
    '{count} 則通知',
    '{count} notifications',
    '{count} notificaciones'
  ),
  'ui.notificationsCollapse': entry(
    '收起通知',
    '收起通知',
    'Collapse notifications',
    'Contraer notificaciones'
  ),
  'ui.dismiss': entry(
    '关闭通知',
    '關閉通知',
    'Dismiss notification',
    'Cerrar notificación'
  ),
  'ui.resize': entry(
    '调整素材与信息宽度',
    '調整素材與資訊寬度',
    'Resize creative and information panels',
    'Ajustar paneles de material e información'
  ),
  'ui.resetLayout': entry(
    '恢复默认布局',
    '恢復預設版面',
    'Reset layout',
    'Restablecer diseño'
  ),
  'ui.refreshFailed': entry(
    '操作已保存，列表刷新失败',
    '操作已儲存，清單重新整理失敗',
    'Saved, but the list could not refresh',
    'Guardado, pero no se pudo actualizar la lista'
  ),
  'ui.refresh': entry(
    '刷新列表',
    '重新整理清單',
    'Refresh list',
    'Actualizar lista'
  ),
  'ui.saved': entry(
    '已收藏到当前工作区',
    '已收藏至目前工作區',
    'Saved to this workspace',
    'Guardado en este espacio'
  ),
  'ui.noteSaved': entry(
    '笔记已保存',
    '筆記已儲存',
    'Note saved',
    'Nota guardada'
  ),
  'ui.downloadStarted': entry(
    '已发起下载',
    '已開始下載',
    'Download requested',
    'Descarga solicitada'
  ),
  'ui.copySource': entry(
    '复制来源链接',
    '複製來源連結',
    'Copy source link',
    'Copiar enlace de origen'
  ),
  'ui.analysisDone': entry(
    '分析已完成',
    '分析已完成',
    'Analysis completed',
    'Análisis completado'
  ),
  'ui.analysisFailed': entry(
    '分析失败，请查看任务详情',
    '分析失敗，請查看工作詳情',
    'Analysis failed. View the task for details',
    'El análisis falló. Consulta la tarea'
  ),
};
