import React, { useEffect, useMemo, useState } from 'react';
import {
    Plus, CheckSquare, Square, Trash2, Edit2, Star, Hourglass, Check, X, BookOpen, AlertTriangle,
} from 'lucide-react';
import { differenceInCalendarDays, format, parseISO, startOfDay } from 'date-fns';
import { fr } from 'date-fns/locale';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { Card, CardContent, Button, Dialog, Input, Textarea, DatePicker, Badge, useToast } from '../components/ui';
import { cn } from '../lib/utils';

// Homework is a task with category = 'homework': due_date is the hand-in date,
// completed_at is when it was actually done, and points + parent approval work
// exactly as for chores (see server/src/routes/tasks.ts).

interface Member { id: string; name: string; color: string }
interface Homework {
    id: string;
    title: string;
    description?: string;
    subject?: string | null;
    category: string;
    is_completed: boolean;
    due_date?: string;
    completed_at?: string;
    points?: number;
    pending_approval?: boolean;
    assigned_to?: string[];
    assigned_to_members?: Member[];
}

const SUBJECTS: { name: string; color: string }[] = [
    { name: 'Maths', color: '#3B82F6' },
    { name: 'Français', color: '#EF4444' },
    { name: 'Allemand', color: '#F59E0B' },
    { name: 'Anglais', color: '#8B5CF6' },
    { name: 'Sciences', color: '#10B981' },
    { name: 'Histoire-Géo', color: '#B45309' },
    { name: 'Lecture', color: '#EC4899' },
];
const subjectColor = (subject?: string | null) => SUBJECTS.find((s) => s.name === subject)?.color ?? '#6B7280';

type SectionKey = 'late' | 'today' | 'tomorrow' | 'week' | 'later' | 'nodate';
const SECTIONS: { key: SectionKey; label: string; tone?: 'danger' }[] = [
    { key: 'late', label: 'En retard', tone: 'danger' },
    { key: 'today', label: "Pour aujourd'hui" },
    { key: 'tomorrow', label: 'Pour demain' },
    { key: 'week', label: 'Cette semaine' },
    { key: 'later', label: 'Plus tard' },
    { key: 'nodate', label: 'Sans date' },
];

const sectionOf = (hw: Homework, today: Date): SectionKey => {
    if (!hw.due_date) return 'nodate';
    const days = differenceInCalendarDays(parseISO(hw.due_date), today);
    if (days < 0) return 'late';
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return days <= 7 ? 'week' : 'later';
};

const dueLabel = (hw: Homework, today: Date): string => {
    if (!hw.due_date) return 'Pas de date';
    const due = parseISO(hw.due_date);
    const days = differenceInCalendarDays(due, today);
    const day = format(due, 'EEEE d MMM', { locale: fr });
    if (days < 0) return `Était pour ${day} (${-days} j de retard)`;
    if (days === 0) return "À rendre aujourd'hui";
    if (days === 1) return 'À rendre demain';
    return `À rendre ${day}`;
};

// "Fait jeudi 2 oct. à 17:40 · à l'heure / en avance de 2 j / 1 j de retard"
const doneLabel = (hw: Homework): string => {
    if (!hw.completed_at) return 'Fait';
    const done = parseISO(hw.completed_at);
    const when = `Fait ${format(done, "EEEE d MMM 'à' HH:mm", { locale: fr })}`;
    if (!hw.due_date) return when;
    const diff = differenceInCalendarDays(done, parseISO(hw.due_date));
    if (diff > 0) return `${when} · ${diff} j de retard`;
    if (diff === 0) return `${when} · à l'heure`;
    return `${when} · en avance de ${-diff} j`;
};

const EMPTY_FORM = { title: '', description: '', subject: '', due_date: '', points: '', assigned_to: [] as string[] };

const HomeworkPage: React.FC = () => {
    const { user } = useAuth();
    const { showToast } = useToast();
    // Child accounts cannot grant points or approve homework (the server enforces it too).
    const isParent = Boolean(user?.is_owner) || user?.role !== 'enfant';

    const [items, setItems] = useState<Homework[]>([]);
    const [members, setMembers] = useState<Member[]>([]);
    const [memberFilter, setMemberFilter] = useState<string>('all');
    const [error, setError] = useState('');
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState<Homework | null>(null);
    const [form, setForm] = useState(EMPTY_FORM);

    const load = async () => {
        try {
            const resp = await api.get<{ success: boolean; data: Homework[] }>('/api/tasks');
            if (resp.success) setItems(resp.data.filter((t) => t.category === 'homework'));
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Impossible de charger les devoirs');
        }
    };

    useEffect(() => {
        void load();
        api.get<{ success: boolean; data: Member[] }>('/api/family')
            .then((r) => { if (r.success) setMembers(r.data); })
            .catch(() => undefined);
    }, []);
    useWebSocketUpdates('tasks', () => { void load(); });

    const today = startOfDay(new Date());

    const visible = useMemo(
        () => items.filter((hw) => memberFilter === 'all' || (hw.assigned_to ?? []).includes(memberFilter)),
        [items, memberFilter],
    );
    const todo = visible.filter((hw) => !hw.is_completed);
    const done = visible
        .filter((hw) => hw.is_completed)
        .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
        .slice(0, 15);

    const grouped = new Map<SectionKey, Homework[]>();
    for (const hw of todo) {
        const key = sectionOf(hw, today);
        grouped.set(key, [...(grouped.get(key) ?? []), hw]);
    }

    const lateCount = grouped.get('late')?.length ?? 0;
    const pointsAtStake = todo.reduce((sum, hw) => sum + (hw.points ?? 0), 0);

    const openCreate = () => {
        setEditing(null);
        setForm({ ...EMPTY_FORM, assigned_to: memberFilter === 'all' ? [] : [memberFilter] });
        setDialogOpen(true);
    };

    const openEdit = (hw: Homework) => {
        setEditing(hw);
        setForm({
            title: hw.title,
            description: hw.description ?? '',
            subject: hw.subject ?? '',
            due_date: hw.due_date ? hw.due_date.slice(0, 10) : '',
            points: hw.points ? String(hw.points) : '',
            assigned_to: hw.assigned_to ?? [],
        });
        setDialogOpen(true);
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        const payload: Record<string, unknown> = {
            title: form.title,
            description: form.description,
            subject: form.subject,
            due_date: form.due_date,
            assigned_to: form.assigned_to,
            category: 'homework',
            // Children never send points; the server ignores it anyway.
            points: isParent ? parseInt(form.points, 10) || 0 : undefined,
        };
        try {
            if (editing) await api.put(`/api/tasks/${editing.id}`, payload);
            else await api.post('/api/tasks', payload);
            setDialogOpen(false);
            void load();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Impossible d'enregistrer le devoir");
        }
    };

    const toggle = async (hw: Homework) => {
        try {
            const resp = await api.put<{ success: boolean; data: Homework }>(`/api/tasks/${hw.id}`, {
                is_completed: !hw.is_completed,
            });
            if (!hw.is_completed && resp.success && resp.data?.pending_approval) {
                showToast({
                    title: 'Bravo, devoir fait !',
                    description: 'Les points arriveront quand un parent aura validé.',
                });
            }
            void load();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Action impossible');
        }
    };

    const decide = async (hw: Homework, verdict: 'approve' | 'reject') => {
        try {
            await api.post(`/api/tasks/${hw.id}/${verdict}`, {});
            void load();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Action impossible');
        }
    };

    const remove = async (hw: Homework) => {
        if (!confirm(`Supprimer « ${hw.title} » ?`)) return;
        try {
            await api.delete(`/api/tasks/${hw.id}`);
            void load();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Suppression impossible');
        }
    };

    const toggleMember = (id: string) =>
        setForm((f) => ({
            ...f,
            assigned_to: f.assigned_to.includes(id) ? f.assigned_to.filter((m) => m !== id) : [...f.assigned_to, id],
        }));

    const renderCard = (hw: Homework, late = false) => (
        <Card
            key={hw.id}
            className={cn(
                'transition-all hover:shadow-md',
                hw.pending_approval && 'border-amber-300 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20',
                late && !hw.is_completed && 'border-red-300 dark:border-red-900',
                hw.is_completed && !hw.pending_approval && 'opacity-70',
            )}
        >
            <CardContent className="p-4">
                <div className="flex items-start gap-4">
                    <button onClick={() => toggle(hw)} className="mt-1 flex-shrink-0" aria-label="Marquer comme fait">
                        {hw.is_completed
                            ? <CheckSquare className="h-5 w-5 text-emerald-600" />
                            : <Square className="h-5 w-5 text-muted-foreground transition-colors hover:text-nexus-blue" />}
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                                <h3 className={cn('mb-1 text-body font-semibold', hw.is_completed && 'text-muted-foreground line-through')}>
                                    {hw.title}
                                </h3>
                                {hw.description && <p className="mb-2 text-body-sm text-muted-foreground">{hw.description}</p>}
                                <div className="flex flex-wrap items-center gap-2">
                                    {hw.subject && (
                                        <span
                                            className="rounded-full px-2 py-0.5 text-micro font-semibold text-white"
                                            style={{ backgroundColor: subjectColor(hw.subject) }}
                                        >
                                            {hw.subject}
                                        </span>
                                    )}
                                    {(hw.points ?? 0) > 0 && (
                                        <Badge variant="warning" className="flex items-center gap-1">
                                            <Star className="h-3 w-3 fill-current" />{hw.points}
                                        </Badge>
                                    )}
                                    {hw.pending_approval && (
                                        <Badge variant="warning" className="flex items-center gap-1">
                                            <Hourglass className="h-3 w-3" />En attente de validation
                                        </Badge>
                                    )}
                                    {(hw.assigned_to_members ?? []).map((m) => (
                                        <Badge key={m.id} variant="primary" className="flex items-center gap-1">
                                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.color }} />{m.name}
                                        </Badge>
                                    ))}
                                </div>
                                <p className={cn('mt-2 text-body-sm', late && !hw.is_completed ? 'font-medium text-red-600' : 'text-muted-foreground')}>
                                    {hw.is_completed ? doneLabel(hw) : dueLabel(hw, today)}
                                </p>
                            </div>
                            <div className="flex items-center gap-1">
                                {isParent && hw.pending_approval && (
                                    <>
                                        <Button variant="secondary" size="sm" onClick={() => decide(hw, 'approve')}>
                                            <Check className="mr-1 h-4 w-4 text-emerald-600" />Valider
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={() => decide(hw, 'reject')}>
                                            <X className="mr-1 h-4 w-4 text-red-500" />Refuser
                                        </Button>
                                    </>
                                )}
                                <Button variant="ghost" size="sm" onClick={() => openEdit(hw)} aria-label="Modifier">
                                    <Edit2 className="h-4 w-4" />
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => remove(hw)} aria-label="Supprimer">
                                    <Trash2 className="h-4 w-4 text-red-500" />
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </CardContent>
        </Card>
    );

    return (
        <div className="mx-auto max-w-4xl space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="flex items-center gap-2 text-h2 font-bold">
                        <BookOpen className="h-6 w-6" />Devoirs
                    </h1>
                    <p className="text-body-sm text-muted-foreground">
                        {todo.length === 0
                            ? 'Rien à faire, bravo !'
                            : `${todo.length} à faire${lateCount ? ` · ${lateCount} en retard` : ''}${pointsAtStake ? ` · ${pointsAtStake} pts à gagner` : ''}`}
                    </p>
                </div>
                <Button onClick={openCreate}><Plus className="mr-2 h-4 w-4" />Ajouter un devoir</Button>
            </div>

            {error && (
                <div className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-body-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
                    <AlertTriangle className="h-4 w-4" />{error}
                </div>
            )}

            {members.length > 1 && (
                <div className="flex flex-wrap gap-2">
                    {[{ id: 'all', name: 'Tous', color: '' }, ...members].map((m) => (
                        <button
                            key={m.id}
                            onClick={() => setMemberFilter(m.id)}
                            className={cn(
                                'flex items-center gap-1.5 rounded-full border px-3 py-1 text-body-sm transition-colors',
                                memberFilter === m.id ? 'border-nexus-blue bg-nexus-blue text-white' : 'hover:bg-muted',
                            )}
                        >
                            {m.color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.color }} />}
                            {m.name}
                        </button>
                    ))}
                </div>
            )}

            {SECTIONS.map(({ key, label, tone }) => {
                const list = grouped.get(key);
                if (!list?.length) return null;
                return (
                    <section key={key} className="space-y-3">
                        <h2 className={cn('text-body font-semibold', tone === 'danger' && 'text-red-600')}>
                            {label} <span className="font-normal text-muted-foreground">({list.length})</span>
                        </h2>
                        {list.map((hw) => renderCard(hw, key === 'late'))}
                    </section>
                );
            })}

            {done.length > 0 && (
                <section className="space-y-3">
                    <h2 className="text-body font-semibold">Faits récemment</h2>
                    {done.map((hw) => renderCard(hw))}
                </section>
            )}

            <Dialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                title={editing ? 'Modifier le devoir' : 'Nouveau devoir'}
                description="Ce qu'il faut faire, pour quand, et pour qui."
            >
                <form onSubmit={submit} className="space-y-4">
                    <Input
                        label="Devoir"
                        value={form.title}
                        onChange={(e) => setForm({ ...form, title: e.target.value })}
                        placeholder="Ex : exercices 4 à 7 page 52"
                        required
                    />
                    <div>
                        <label className="mb-1.5 block text-label font-medium text-foreground">Matière</label>
                        <div className="flex flex-wrap gap-2">
                            {SUBJECTS.map((s) => (
                                <button
                                    type="button"
                                    key={s.name}
                                    onClick={() => setForm({ ...form, subject: form.subject === s.name ? '' : s.name })}
                                    className={cn(
                                        'rounded-full border px-3 py-1 text-body-sm transition-colors',
                                        form.subject === s.name ? 'text-white' : 'hover:bg-muted',
                                    )}
                                    style={form.subject === s.name ? { backgroundColor: s.color, borderColor: s.color } : undefined}
                                >
                                    {s.name}
                                </button>
                            ))}
                        </div>
                    </div>
                    {members.length > 0 && (
                        <div>
                            <label className="mb-1.5 block text-label font-medium text-foreground">Pour qui</label>
                            <div className="flex flex-wrap gap-2">
                                {members.map((m) => (
                                    <button
                                        type="button"
                                        key={m.id}
                                        onClick={() => toggleMember(m.id)}
                                        className={cn(
                                            'flex items-center gap-1.5 rounded-full border px-3 py-1 text-body-sm transition-colors',
                                            form.assigned_to.includes(m.id) ? 'border-nexus-blue bg-nexus-blue text-white' : 'hover:bg-muted',
                                        )}
                                    >
                                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.color }} />{m.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    <DatePicker label="À rendre le" value={form.due_date} onChange={(v) => setForm({ ...form, due_date: v })} />
                    <Textarea
                        label="Détails (optionnel)"
                        value={form.description}
                        onChange={(e) => setForm({ ...form, description: e.target.value })}
                        rows={2}
                    />
                    {isParent && (
                        <Input
                            label="Points à gagner"
                            type="number"
                            min={0}
                            value={form.points}
                            onChange={(e) => setForm({ ...form, points: e.target.value })}
                            placeholder="0"
                        />
                    )}
                    <div className="flex justify-end gap-2 pt-2">
                        <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>Annuler</Button>
                        <Button type="submit">{editing ? 'Enregistrer' : 'Ajouter'}</Button>
                    </div>
                </form>
            </Dialog>
        </div>
    );
};

export default HomeworkPage;
