export const metadata={title:'Privacy and recording rules — Pass the Movie',robots:{index:false,follow:false}};
export default function Privacy(){
  return <main className="mx-auto flex min-h-dvh max-w-[440px] flex-col gap-4 px-6 py-8">
    <a href="/" className="font-black">PASS THE MOVIE.</a>
    <h1 className="text-3xl font-black">Privacy and recording rules</h1>
    <p className="rounded-xl bg-[#e6b84d] p-3 text-sm font-bold">Local development notice. Use synthetic test recordings only. Not the public privacy policy or terms.</p>
    <h2 className="text-lg font-bold">Your recording</h2>
    <p>Retakes stay in your browser until you submit. Only the last frame of an accepted scene is shown to the next contributor. After all five scenes are accepted and processed, contributors can watch and download the completed movie.</p>
    <h2 className="text-lg font-bold">Who can play</h2>
    <p>Participants must be 18 or older, have permission from everyone identifiable in the clip, and have rights to the recorded material. Do not record minors or other people without permission. No unlawful, abusive or infringing recordings.</p>
    <h2 className="text-lg font-bold">How long we keep it</h2>
    <p>Unfinished movies expire after seven days. Completed movies are available for seven days after publication. Raw clips and intermediate files are scheduled for removal after processing. Access expires before asynchronous storage cleanup completes. Minimal deletion records may be retained temporarily to catch late files.</p>
    <h2 className="text-lg font-bold">Deleting a movie</h2>
    <p>The creator or any accepted contributor can revoke access to the entire movie and request removal of stored media. Pending contributors can abandon their own turn. Copies already downloaded or shared elsewhere cannot be recalled by the app.</p>
    <h2 className="text-lg font-bold">Private links and reports</h2>
    <p>Keep your recovery link private. An invitation is for the next turn only. The local app uses a browser session cookie and stores no account profile. Reports contain a category and optional movie identifier, not video or a private access link.</p>
    <p>There is no public service or staffed reporting process at this development stage. A full notice, terms and actual operator contact will be required before public use.</p>
    <a className="ptm-secondary" href="/report">Report a concern</a>
  </main>;
}
