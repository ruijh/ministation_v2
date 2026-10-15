// MiniMax may end at EOF after finish_reason and an explicit successful usage
// event, without OpenAI's [DONE]. Never accept bare EOF as successful completion.
export class StreamCompletion {
 constructor(){this.done=false;this.choices=new Map();this.minimaxSuccess=false;}
 observe(event){
  for(const choice of event.choices||[])this.choices.set(choice.index,Boolean(choice.finish_reason));
  if(event.base_resp)this.minimaxSuccess=event.base_resp.status_code===0&&Number.isSafeInteger(event.usage?.prompt_tokens)&&Number.isSafeInteger(event.usage?.completion_tokens);
 }
 canNormalize(){return this.minimaxSuccess&&this.choices.size>0&&[...this.choices.values()].every(Boolean);}
}
