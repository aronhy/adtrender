import { useWorkspaceLocale } from '../workspace-i18n/locale';
import { translateAdminCopy, type AdminCopyDictionary } from './admin-copy-core';
export { adminCopy, translateAdminCopy } from './admin-copy-core';
export type { AdminCopyDictionary } from './admin-copy-core';
export function useAdminCopy(extra?:AdminCopyDictionary){const{locale}=useWorkspaceLocale();return {locale,t:(chinese:string,values?:Record<string,string|number>)=>translateAdminCopy(locale,chinese,values,extra)};}
