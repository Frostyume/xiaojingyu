export const ASSET_TOOL_NAMES=Object.freeze(['xi_assets_media_list','xi_assets_media_get','xi_workroom_list','xi_workroom_read','xi_workroom_history','xi_workroom_create','xi_workroom_write','xi_workroom_restore','xi_workroom_display','xi_assets_media_prepare']);
export const ASSET_DSH_NAMES=Object.freeze(ASSET_TOOL_NAMES.map(name=>'mcp__snowluma-host__'+name));
export const WORKSHOP_DSH_NAMES=Object.freeze(['workshop_status','workshop_draft','workshop_restore_draft','workshop_submit','workshop_control','workshop_resume'].map(name=>'mcp__snowluma-host__'+name));
