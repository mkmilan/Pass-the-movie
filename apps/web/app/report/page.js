'use client';

import { useEffect,useState } from 'react';

const reasons=[['privacy','Privacy or recording without permission'],['abuse','Abusive or harmful content'],['copyright','Copyright or other rights'],['illegal','Illegal content'],['other','Other concern']];
export default function Report(){
  const [movieId,setMovieId]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState('');
  useEffect(()=>{
    const candidate=new URL(window.location.href).searchParams.get('movie');
    if(candidate&&/^[0-9a-f-]{36}$/i.test(candidate))setMovieId(candidate);
  },[]);
  async function submit(e){
    e.preventDefault();if(busy||!reason)return;
    setBusy(true);setError('');
    try{
      const host=window.location.hostname;
      if(!['localhost','127.0.0.1'].includes(host))throw Error('Reporting is local-development only.');
      const origin=new URL(process.env.NEXT_PUBLIC_API_ORIGIN||('http://'+host+':4000'));
      if(origin.hostname!==host||!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Invalid local API origin.');
      const response=await fetch(origin.origin+'/v1/reports',{method:'POST',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason,movieId:movieId.trim()})});
      const result=await response.json();
      if(!response.ok)throw Error(result.code||'REPORT_FAILED');
      setReceipt(result.reportId);
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <main className="mx-auto flex min-h-dvh max-w-[440px] flex-col gap-4 px-6 py-8">
    <a href="/" className="font-black">PASS THE MOVIE.</a><h1 className="text-3xl font-black">Report a concern</h1>
    <p className="text-sm">Local test form only. Reports are recorded for developer review, not a staffed emergency or public reporting service. Do not include private links, personal information or recordings.</p>
    {receipt?<section role="status"><p>Report recorded. Reference:</p><p className="break-all font-bold">{receipt}</p></section>:<form className="flex flex-col gap-4" onSubmit={submit}>
      <label className="flex flex-col gap-2">Movie ID (optional)<input value={movieId} onChange={e=>setMovieId(e.target.value)} maxLength={36} className="rounded-lg border p-3" autoComplete="off"/></label>
      <label className="flex flex-col gap-2">Reason<select required value={reason} onChange={e=>setReason(e.target.value)} className="rounded-lg border p-3"><option value="">Select a reason</option>{reasons.map(([id,title])=><option key={id} value={id}>{title}</option>)}</select></label>
      {error&&<p role="alert" className="text-sm">{error}</p>}
      <button className="ptm-primary" disabled={!reason||busy}>{busy?'Submitting…':'Submit report'}</button>
    </form>}
    <a href="/privacy" className="text-sm underline">Privacy and recording rules</a>
  </main>;
}
