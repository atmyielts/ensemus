'use client';
import {useActionState,useEffect,useId,useRef} from 'react';
import type {ProcessDraftView} from '@ensemus/application/process-specs';
import type {ProcessGraph,ProcessGraphNode} from '@ensemus/domain/process-spec';
import type {WorkflowFormState} from '@/lib/process-studio-input';
import {WORKFLOW_KIND_NAMES,workflowConnections,type WorkflowChoices} from '@/lib/process-studio-present';
import {saveWorkflowDetailsAction,saveWorkflowPointAction} from '@/server/process-studio-actions';
import {ErrorNotice} from '../ui';
import {SubmitButton} from '../submit-button';

export function WorkflowDetailsForm({organizationId,draft,requestKey}:{organizationId:string;draft?:ProcessDraftView;requestKey:string}){
 const [state,action]=useActionState<WorkflowFormState,FormData>(saveWorkflowDetailsAction,{}),prefix=useId(),notice=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(state.code)notice.current?.focus();},[state]);
 const value=(key:string,initial='')=>state.values?.[key]?.[0]??initial;
 return <form action={action} className="card fields form-width" key={state.revision??0}>
  <div ref={notice} tabIndex={-1}><ErrorNotice code={state.code}/></div>
  <input type="hidden" name="organizationId" value={organizationId}/><input type="hidden" name="requestKey" value={value('requestKey',requestKey)}/>
  {draft&&<><input type="hidden" name="draftId" value={draft.id}/><input type="hidden" name="version" value={draft.version}/></>}
  <label htmlFor={`${prefix}-name`}>Workflow name</label><input id={`${prefix}-name`} name="name" required maxLength={120} defaultValue={value('name',draft?.name)} />
  <label htmlFor={`${prefix}-class`}>Definition sensitivity</label><select id={`${prefix}-class`} name="classification" defaultValue={value('classification',draft?.classification??'internal')} aria-describedby={`${prefix}-class-help`}>
   <option value="public">Public</option><option value="internal">Internal</option><option value="confidential">Confidential</option><option value="restricted">Restricted</option>
  </select><p id={`${prefix}-class-help`} className="muted">This covers the definition and its step labels. Restricted drafts are readable only by their responsible person, and cannot contain assistant or outside-action steps. Current source access is checked separately when work runs.</p>
  <p className="muted">{draft?'Saving a changed definition cancels open reviews. Existing published versions stay fixed.':'You become the responsible person. Start and Finish are included; add the actual steps next. Creating a draft starts no run.'}</p>
  <div><SubmitButton working={draft?'Saving the definition':'Creating the draft'}>{draft?'Save workflow details':'Create workflow draft'}</SubmitButton></div>
 </form>;
}

export function WorkflowPointForm({organizationId,draftId,version,graph,node,newNodeId,requestKey,choices}:{organizationId:string;draftId:string;version:number;graph:ProcessGraph;node?:ProcessGraphNode;newNodeId?:string;requestKey:string;choices:WorkflowChoices}){
 const [state,action]=useActionState<WorkflowFormState,FormData>(saveWorkflowPointAction,{}),prefix=useId(),notice=useRef<HTMLDivElement>(null),nodeId=node?.id??newNodeId;
 useEffect(()=>{if(state.code)notice.current?.focus();},[state]);
 const value=(key:string,initial='')=>state.values?.[key]?.[0]??initial;
 if(!nodeId)throw new Error('WORKFLOW_POINT_INTENT_MISSING');
 const ends=graph.nodes.filter(n=>n.kind==='end').map(n=>n.id),starts=graph.nodes.filter(n=>n.kind==='start').map(n=>n.id);
 const before=node?graph.edges.filter(e=>e.to===node.id).map(e=>e.from):graph.edges.filter(e=>ends.includes(e.to)).map(e=>e.from);
 const initialPrevious=node?before:before.length?before:starts;
 const initialNext=node?graph.edges.filter(e=>e.from===node.id).map(e=>e.to):ends;
 const previous=state.values?state.values.previous??[]:initialPrevious,next=state.values?state.values.next??[]:initialNext;
 const previousChoices=workflowConnections(graph,nodeId,previous),nextChoices=workflowConnections(graph,nodeId,next);
 const selectedAgent=value('agentDefinitionId',node?.agentDefinitionId??''),selectedTool=value('toolId',node?.toolId??''),selectedApprover=value('approverRole',node?.approverRole??'');
 return <form action={action} className="fields" key={state.revision??0}>
  <div ref={notice} tabIndex={-1}><ErrorNotice code={state.code}/></div>
  <input type="hidden" name="organizationId" value={organizationId}/><input type="hidden" name="draftId" value={draftId}/><input type="hidden" name="version" value={version}/><input type="hidden" name="requestKey" value={value('requestKey',requestKey)}/><input type="hidden" name="mode" value={node?'update':'add'}/><input type="hidden" name="nodeId" value={nodeId}/>
  <label htmlFor={`${prefix}-label`}>Point name</label><input id={`${prefix}-label`} name="label" required maxLength={120} defaultValue={value('label',node?.label)} />
  <label htmlFor={`${prefix}-kind`}>What happens here?</label><select id={`${prefix}-kind`} name="kind" defaultValue={value('kind',node?.kind??'work_item')} aria-describedby={`${prefix}-kind-help`}>{Object.entries(WORKFLOW_KIND_NAMES).map(([kind,label])=><option value={kind} key={kind}>{label}</option>)}</select><p id={`${prefix}-kind-help`} className="muted">Start and Finish are boundary points. Other points are real work, an approval, a proposed action or an evidence check. Saving an incomplete draft is allowed; only a valid definition can be rehearsed for review.</p>
  <details open={node!==undefined&&!['start','end','work_item'].includes(node.kind)}>
   <summary>Options for the selected point type</summary>
   <p className="muted">Choose the matching options below. Other options are ignored. These controls also work without JavaScript.</p>
   <label htmlFor={`${prefix}-agent`}>For an assistant point: published assistant</label><select id={`${prefix}-agent`} name="agentDefinitionId" defaultValue={selectedAgent} aria-describedby={`${prefix}-agent-help`}>
    <option value="">Choose a currently offered published assistant</option>
    {selectedAgent&&!choices.agents?.some(a=>a.id===selectedAgent)&&<option value={selectedAgent}>Saved assistant is not currently offered — choose another to change it</option>}
    {choices.agents?.map(a=><option key={a.id} value={a.id}>{a.name} · Offered version {a.versionNumber}</option>)}
   </select><p id={`${prefix}-agent-help`} className="muted">{choices.agents===null?'The published assistant catalog is unavailable here. No empty catalog is assumed.':choices.agents.length?'A future run pins an actual permitted published version when this step starts. Editing does not start an assistant.':'No active published assistant is currently offered. Publish one separately, or use work for a person.'}</p>
   <label htmlFor={`${prefix}-tool`}>For an outside-action point: action to propose</label><select id={`${prefix}-tool`} name="toolId" defaultValue={selectedTool} aria-describedby={`${prefix}-tool-help`}>
    <option value="">Choose an available outside action</option>
    {selectedTool&&!choices.tools?.some(t=>t.id===selectedTool)&&<option value={selectedTool}>Saved outside action is not available — choose another to change it</option>}
    {choices.tools?.map(tool=><option key={tool.id} value={tool.id}>{tool.name}</option>)}
   </select><p id={`${prefix}-tool-help`} className="muted">{choices.tools===null?'The outside-action catalog is unavailable here.':'Every path to this point must first pass a person’s approval. A real action also needs its actual connection, payload and separate action approval at runtime. Nothing is sent by editing.'}</p>
   <label htmlFor={`${prefix}-approver`}>For an approval point: who may decide?</label><select id={`${prefix}-approver`} name="approverRole" defaultValue={selectedApprover} aria-describedby={`${prefix}-approver-help`}>
    <option value="">Choose how an eligible person is found</option><option value="process_owner">Workflow publisher, or an eligible organization administrator</option><option value="named_reviewer">A person assigned as reviewer on the run’s main Work</option>{selectedApprover==='starter_manager'&&<option value="starter_manager">Saved manager selection — unavailable here</option>}
   </select><p id={`${prefix}-approver-help`} className="muted">An approver must be a current person who can read the Work and must differ from the person asking. No person is assigned by this dropdown. Manager relationships are not available here.</p>
   <label htmlFor={`${prefix}-evidence`}>For an evidence point: what must exist?</label><select id={`${prefix}-evidence`} name="evidence" defaultValue={value('evidence',node?.evidence??'')}>
    <option value="">Choose required evidence</option><option value="artifact_attached">A file attached to the work</option><option value="external_receipt">A verified outside-action receipt</option><option value="reviewer_approved">The current result has human approval</option>
   </select>
  </details>
  <details open={!node}>
   <summary>Connections and parallel paths</summary><p className="muted">Connections set execution order. Every selected earlier point must finish before this one. Multiple later points create parallel paths; there is no automatic if/else routing. Save one point at a time.</p>
   <fieldset><legend>Earlier points: all must finish first</legend>{previousChoices.length?previousChoices.map(point=><label className="check" key={point.id}><input type="checkbox" name="previous" value={point.id} defaultChecked={previous.includes(point.id)}/>{point.label}</label>):<p>No other point is available yet.</p>}</fieldset>
   <fieldset><legend>Later points: continue to each selected point</legend>{nextChoices.length?nextChoices.map(point=><label className="check" key={point.id}><input type="checkbox" name="next" value={point.id} defaultChecked={next.includes(point.id)}/>{point.label}</label>):<p>No other point is available yet.</p>}</fieldset>
   {!node&&<label className="check"><input type="checkbox" name="replaceDirect" value="yes" defaultChecked={state.values?value('replaceDirect')==='yes':true}/>Insert between those points: replace their direct connections. Uncheck to keep an additional parallel path.</label>}
  </details>
  <div><SubmitButton working={node?'Saving this point':'Adding this point'}>{node?'Save this point':'Add this point'}</SubmitButton></div>
 </form>;
}
