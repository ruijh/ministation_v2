import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

function sources(dir){
 return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  const path=join(dir,entry.name);
  return entry.isDirectory()?sources(path):/\.(mjs|js)$/.test(path)?[path]:[];
 });
}

const files=['vite.config.js','playwright.config.js',...['server','scripts','tests'].flatMap(sources)];
for(const file of files){
 const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status||1);
}
console.log(`Syntax checked ${files.length} JavaScript files (JSX is checked by Vite build).`);
