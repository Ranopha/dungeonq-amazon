import { appendFileSync,closeSync,constants,fsyncSync,openSync,renameSync,writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export function durableJson(path,value){
  const temporary=path+'.tmp',fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,path);const directory=openSync(dirname(path),constants.O_RDONLY);
  try{fsyncSync(directory);}finally{closeSync(directory);}
}
export function durableEvent(path,value){
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
  try{appendFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
}
