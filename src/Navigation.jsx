import React from 'react';
import {Activity,Database,Boxes,Terminal,Settings,Monitor} from 'lucide-react';
const groups=[
 {home:'overview',label:'运行总览',icon:Activity,pages:['overview']},
 {home:'models',label:'模型资产',icon:Database,pages:['models','templates']},
 {home:'deployments',label:'服务部署',icon:Boxes,pages:['deployments','backends','routes'],advanced:['distributed','flows','releases','autoscaling','native']},
 {home:'playground',label:'在线调试',icon:Terminal,pages:['playground','keys']},
 {home:'monitoring',label:'监控告警',icon:Monitor,pages:['monitoring','metrics','usage','operations']},
 {home:'settings',label:'平台设置',icon:Settings,pages:['settings'],advanced:['capacity','policy','cluster','audit']}
];
const groupFor=page=>groups.find(g=>[...g.pages,...g.advanced||[]].includes(page));
const allowed=(id,admin)=>admin||!['settings','cluster','capacity'].includes(id);
export function MainNavigation({page,admin,onNavigate}){return <nav aria-label="主要导航"><div className="nav-group">{groups.map(g=>{const Icon=g.icon;const target=g.home==='settings'&&!admin?'policy':g.home;return <a key={g.home} href={'#'+target} className={groupFor(page)===g?'active':''} aria-current={page===target?'page':undefined} onClick={onNavigate}><Icon size={18}/>{g.label}</a>;})}</div></nav>;}
export function ContextNavigation({page,admin,titles}){const g=groupFor(page);if(!g||g.pages.length===1&&!g.advanced)return null;return <nav className="context-nav" aria-label="当前功能导航">{g.pages.filter(id=>allowed(id,admin)).map(id=><a key={id} href={'#'+id} className={page===id?'active':''} aria-current={page===id?'page':undefined}>{titles[id]}</a>)}{g.advanced&&<details key={g.home} open={g.advanced.includes(page)}><summary>高级功能</summary><div>{g.advanced.filter(id=>allowed(id,admin)).map(id=><a key={id} href={'#'+id} className={page===id?'active':''}>{titles[id]}</a>)}</div></details>}</nav>;}
