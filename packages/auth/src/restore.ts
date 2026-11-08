// Operator-only packaged recovery entry. No HTTP endpoint imports/calls this function.
import {openAuthDatabase,invalidateRestoredAuthentication} from '@ensemus/database/auth';
import {symmetricDecrypt,symmetricEncrypt} from 'better-auth/crypto';

export async function invalidateAuthenticationAfterRestore(input:{
  databaseUrl:string;secret:string;generation:string;
}){
  if(input.secret.length<32||input.secret.length>4096)throw new Error('AUTH_RESTORE_KEY_REFUSED');
  const emptyBackupCiphertext=await symmetricEncrypt({key:input.secret,data:'[]'});
  const database=openAuthDatabase(input.databaseUrl);
  try{
    return await invalidateRestoredAuthentication(database.db,{
      generation:input.generation,emptyBackupCiphertext,
      verifyFactorCiphertext:async ciphertext=>{
        const plain=await symmetricDecrypt({key:input.secret,data:ciphertext});
        if(!plain||plain.length>4096)throw new Error('AUTH_RESTORE_FACTOR_REFUSED');
      },
      verifyEmptyBackupCiphertext:async ciphertext=>{
        if(await symmetricDecrypt({key:input.secret,data:ciphertext})!=='[]')throw new Error('AUTH_RESTORE_BACKUP_SET_NOT_REVOKED');
      },
    });
  }finally{await database.close();}
}
