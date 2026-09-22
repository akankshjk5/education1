'use client';

import {
  CheckCircle2,
  Clapperboard,
  CircleX,
  Download,
  ImageIcon,
  Languages,
  LoaderCircle,
  Mic2,
  Play,
  Square,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { VIDEO_SUBJECTS } from '@/lib/videos/contracts';
import {
  LESSON_VIDEO_DURATIONS,
  type LessonVideoDetail,
  type LessonVideoDuration,
  type LessonVideoProject,
  type LessonVideoScene,
} from '@/lib/videos/lesson-contracts';
import { VIDEO_LANGUAGES, type VideoLanguageCode } from '@/lib/videos/languages';

const fieldClasses =
  'w-full rounded-lg border border-black/10 bg-white px-3 py-2.5 text-sm outline-none transition-colors focus:border-indigo-500 dark:border-white/10 dark:bg-neutral-900';

function isRunning(project: LessonVideoProject | null): boolean {
  return Boolean(project && [
    'generating_images',
    'generating_videos',
    'assembling',
  ].includes(project.status));
}

export function LessonVideoStudio({ initialProjects }: { initialProjects: LessonVideoProject[] }) {
  const [projects, setProjects] = useState(initialProjects);
  const [selected, setSelected] = useState<LessonVideoProject | null>(initialProjects[0] ?? null);
  const [scenes, setScenes] = useState<LessonVideoScene[]>([]);
  const [progress, setProgress] = useState(initialProjects[0]?.status === 'succeeded' ? 100 : 0);
  const [classLevel, setClassLevel] = useState(8);
  const [subject, setSubject] = useState('');
  const [topic, setTopic] = useState('');
  const [languageCode, setLanguageCode] = useState<VideoLanguageCode>('en-IN');
  const [targetDurationSeconds, setTargetDurationSeconds] = useState<LessonVideoDuration>(60);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedId = selected?.id ?? null;
  const running = isRunning(selected);

  useEffect(() => {
    if (!selectedId) return;
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/lesson-videos/${selectedId}`, { cache: 'no-store' });
        const body = await response.json() as LessonVideoDetail & { error?: string };
        if (!response.ok) throw new Error(body.error ?? 'Could not refresh video status.');
        if (stopped) return;
        setSelected(body.project);
        setScenes(body.scenes);
        setProgress(body.progress);
        setProjects((current) => [
          body.project,
          ...current.filter((project) => project.id !== body.project.id),
        ]);
        if (isRunning(body.project)) timer = window.setTimeout(() => void poll(), 2000);
      } catch (caught) {
        if (!stopped) setError(caught instanceof Error ? caught.message : 'Could not refresh video status.');
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [selectedId, running]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/lesson-videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classLevel, subject, topic, languageCode, targetDurationSeconds }),
      });
      const body = await response.json() as { project?: LessonVideoProject; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error ?? 'Could not start video.');
      setSelected(body.project);
      setScenes([]);
      setProgress(0);
      setProjects((current) => [body.project!, ...current]);
      setTopic('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start video.');
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel() {
    if (!selected) return;
    try {
      const response = await fetch(`/api/lesson-videos/${selected.id}`, { method: 'DELETE' });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Could not cancel video.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not cancel video.');
    }
  }

  return (
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(340px,430px)_minmax(0,1fr)]">
      <div className="space-y-5">
        <form onSubmit={submit} className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-neutral-900">
          <div className="flex items-center gap-2"><Clapperboard className="h-5 w-5 text-indigo-600 dark:text-indigo-400" /><h2 className="font-semibold">Create a narrated lesson</h2></div>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">Lumina plans the lesson, creates topic-specific scenes locally, adds voice-over, and assembles one learning video.</p>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <label className="text-sm font-medium">Class<select value={classLevel} onChange={(event) => setClassLevel(Number(event.target.value))} className={`${fieldClasses} mt-1.5`}>{Array.from({ length: 12 }, (_, index) => index + 1).map((grade) => <option key={grade} value={grade}>Class {grade}</option>)}</select></label>
            <label className="text-sm font-medium">Subject<select required value={subject} onChange={(event) => setSubject(event.target.value)} className={`${fieldClasses} mt-1.5`}><option value="" disabled>Select subject</option>{VIDEO_SUBJECTS.map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
          <label className="mt-3 block text-sm font-medium">Topic<input required minLength={3} maxLength={300} value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="e.g. How Python loops work" className={`${fieldClasses} mt-1.5`} /></label>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="text-sm font-medium">Voice-over language<select value={languageCode} onChange={(event) => setLanguageCode(event.target.value as VideoLanguageCode)} className={`${fieldClasses} mt-1.5`}>{VIDEO_LANGUAGES.map((language) => <option key={language.code} value={language.code}>{language.label}</option>)}</select></label>
            <label className="text-sm font-medium">Video length<select value={targetDurationSeconds} onChange={(event) => setTargetDurationSeconds(Number(event.target.value) as LessonVideoDuration)} className={`${fieldClasses} mt-1.5`}>{LESSON_VIDEO_DURATIONS.map((duration) => <option key={duration} value={duration}>{duration} seconds</option>)}</select></label>
          </div>
          <button type="submit" disabled={submitting} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">{submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}{submitting ? 'Planning lesson and voice-over…' : 'Generate narrated video'}</button>
          {!submitting && (!subject || topic.trim().length < 3) ? <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Choose a subject and enter a topic of at least 3 characters.</p> : null}
          {error ? <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        </form>

        {projects.length > 0 ? <section><h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">Recent videos</h2><div className="space-y-2">{projects.map((project) => <button key={project.id} type="button" onClick={() => { setSelected(project); setScenes([]); setProgress(project.status === 'succeeded' ? 100 : 0); setError(null); }} className={`w-full rounded-xl border p-3 text-left transition-colors ${selected?.id === project.id ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10' : 'border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5'}`}><span className="block truncate text-sm font-medium">{project.title}</span><span className="mt-0.5 block text-xs text-neutral-500">Class {project.class_level} · {project.subject} · {project.target_duration_seconds}s · {project.language_name} · {statusLabel(project.status)}</span></button>)}</div></section> : null}
      </div>

      <ResultPanel project={selected} scenes={scenes} progress={progress} onCancel={() => void cancel()} />
    </div>
  );
}

function ResultPanel({ project, scenes, progress, onCancel }: { project: LessonVideoProject | null; scenes: LessonVideoScene[]; progress: number; onCancel: () => void }) {
  if (!project) return <div className="flex min-h-[480px] items-center justify-center rounded-2xl border border-dashed border-black/15 bg-black/[0.02] p-8 text-center dark:border-white/15 dark:bg-white/[0.02]"><div><Clapperboard className="mx-auto h-9 w-9 text-neutral-300" /><p className="mt-3 text-sm text-neutral-500">Your narrated lesson will appear here.</p></div></div>;

  const running = isRunning(project);
  const generatedImages = scenes.filter((scene) => scene.image_url);
  return (
    <section className="overflow-hidden rounded-2xl border border-black/10 bg-neutral-950 text-white shadow-sm dark:border-white/10">
      <div className="flex min-h-[360px] items-center justify-center bg-black">
        {project.final_video_url ? <video src={project.final_video_url} controls playsInline className="aspect-video max-h-[70vh] w-full object-contain" /> : generatedImages.length > 0 ? <div className="grid aspect-video w-full grid-cols-2 gap-1 overflow-hidden bg-neutral-900 p-1 sm:grid-cols-4">{generatedImages.slice(0, 12).map((scene) => <img key={scene.id} src={scene.image_url!} alt={`Scene ${scene.scene_index}`} className="h-full min-h-24 w-full object-cover" />)}</div> : project.status === 'cancelled' ? <TerminalState title="Generation cancelled" description="Queued work has been stopped." /> : project.status === 'failed' ? <TerminalState title="Generation failed" description={project.error_message ?? 'Start a new request when you are ready to try again.'} /> : <div className="text-center"><LoaderCircle className="mx-auto h-9 w-9 animate-spin text-indigo-400" /><p className="mt-3 text-sm">{statusLabel(project.status)}…</p></div>}
      </div>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4"><div><h2 className="font-semibold">{project.title}</h2><p className="mt-1 text-xs text-neutral-400">Class {project.class_level} · {project.subject} · {project.target_duration_seconds} seconds · {project.language_name}</p><p className="mt-2 text-xs leading-relaxed text-neutral-300">{project.learning_objective}</p></div>{project.final_video_url ? <a href={project.final_video_url} download className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-semibold text-neutral-950 hover:bg-neutral-200"><Download className="h-3.5 w-3.5" />Download</a> : null}</div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-xs"><Stage done={['generating_videos', 'assembling', 'succeeded'].includes(project.status)} active={project.status === 'generating_images'} icon={ImageIcon} label="Create scenes" /><Stage done={['assembling', 'succeeded'].includes(project.status)} active={project.status === 'generating_videos'} icon={Clapperboard} label="Animate scenes" /><Stage done={project.status === 'succeeded'} active={project.status === 'assembling'} icon={Mic2} label="Voice + assemble" /></div>
        {running ? <div className="mt-4"><div className="flex items-center justify-between gap-3 text-xs"><span className="text-neutral-400">{statusLabel(project.status)} · {progress}%</span><button type="button" onClick={onCancel} className="inline-flex items-center gap-1.5 text-red-300 hover:text-red-200"><Square className="h-3 w-3 fill-current" />Cancel</button></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-indigo-400 transition-all" style={{ width: `${progress}%` }} /></div></div> : null}
        {scenes.length > 0 ? <div className="mt-5 border-t border-white/10 pt-4"><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-neutral-400"><Languages className="h-3.5 w-3.5" />Lesson scenes</div><div className="mt-3 grid gap-2 sm:grid-cols-2">{scenes.map((scene) => <div key={scene.id} className="rounded-lg bg-white/5 p-3"><div className="flex items-center justify-between gap-2 text-xs"><span className="font-semibold">Scene {scene.scene_index}</span><span className="text-neutral-500">{sceneStatus(scene.status)}</span></div><p className="mt-1 text-xs leading-relaxed text-neutral-300">{scene.fact}</p></div>)}</div></div> : null}
      </div>
    </section>
  );
}

function TerminalState({ title, description }: { title: string; description: string }) {
  return <div className="px-6 text-center"><CircleX className="mx-auto h-9 w-9 text-neutral-500" /><p className="mt-3 text-sm font-medium">{title}</p><p className="mt-1 text-xs text-neutral-500">{description}</p></div>;
}

function Stage({ done, active, icon: Icon, label }: { done: boolean; active: boolean; icon: typeof ImageIcon; label: string }) {
  return <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${done ? 'bg-emerald-500/15 text-emerald-300' : active ? 'bg-indigo-500/15 text-indigo-300' : 'bg-white/5 text-neutral-500'}`}>{done ? <CheckCircle2 className="h-4 w-4" /> : active ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}<span>{label}</span></div>;
}

function statusLabel(status: LessonVideoProject['status']): string {
  if (status === 'generating_images') return 'Creating topic visuals';
  if (status === 'generating_videos') return 'Animating lesson scenes';
  if (status === 'assembling') return 'Adding voice-over and assembling';
  if (status === 'succeeded') return 'Ready';
  if (status === 'cancelled') return 'Cancelled';
  return 'Failed';
}

function sceneStatus(status: LessonVideoScene['status']): string {
  if (status === 'queued_image') return 'Waiting for visual';
  if (status === 'generating_image') return 'Creating visual';
  if (status === 'queued_video') return 'Visual ready';
  if (status === 'generating_video') return 'Animating';
  if (status === 'succeeded') return 'Ready';
  if (status === 'cancelled') return 'Cancelled';
  return 'Failed';
}
