import { Router } from "express";
import { requireAuth } from "../auth/index.js";
import {
  createTask, updateTask, completeTask, cancelTask, deleteTask, rescheduleTask,
  listTasks, getTaskById, findTaskByTitle,
} from "../actions/tools.js";
import { toolError } from "../actions/tools.js";

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

const asUser = (req: any): string => req.user.id;

tasksRouter.get("/", (req, res) => {
  try {
    const { status, projectSlug, priority, search, limit, includeCompleted } = req.query;
    const tasks = listTasks(asUser(req), {
      status: typeof status === "string" ? status : undefined,
      projectSlug: typeof projectSlug === "string" ? projectSlug : undefined,
      priority: typeof priority === "string" ? (priority as any) : undefined,
      search: typeof search === "string" ? search : undefined,
      limit: limit ? Number(limit) : undefined,
      includeCompleted: includeCompleted === "true",
    });
    res.json({ tasks });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to list tasks." });
  }
});

tasksRouter.get("/:id", (req, res) => {
  try {
    const task = getTaskById(asUser(req), req.params.id);
    res.json({ task });
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : "Task not found." });
  }
});

tasksRouter.post("/", (req, res) => {
  try {
    const b = req.body ?? {};
    const task = createTask(asUser(req), {
      title: b.title,
      description: b.description,
      projectSlug: b.projectSlug,
      priority: b.priority,
      deadlineAt: b.deadlineAt,
      dueDate: b.dueDate,
      dueTime: b.dueTime,
      status: b.status,
      taskType: b.taskType,
      recurrence: b.recurrence,
      people: b.people,
      notes: b.notes,
      source: b.source || "manual",
      clientId: b.clientId,
      reminderAt: b.reminderAt,
    });
    res.status(201).json({ task });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to create task." });
  }
});

tasksRouter.patch("/:id", (req, res) => {
  try {
    const b = req.body ?? {};
    const task = updateTask(asUser(req), req.params.id, {
      title: b.title,
      description: b.description,
      projectSlug: b.projectSlug,
      priority: b.priority,
      status: b.status,
      taskType: b.taskType,
      deadlineAt: b.deadlineAt,
      recurrence: b.recurrence,
      people: b.people,
      notes: b.notes,
    });
    res.json({ task });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to update task." });
  }
});

tasksRouter.post("/:id/complete", (req, res) => {
  try {
    const task = completeTask(asUser(req), req.params.id);
    res.json({ task });
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : "Task not found." });
  }
});

tasksRouter.post("/:id/cancel", (req, res) => {
  try {
    const task = cancelTask(asUser(req), req.params.id);
    res.json({ task });
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : "Task not found." });
  }
});

tasksRouter.post("/:id/reschedule", (req, res) => {
  try {
    const task = rescheduleTask(asUser(req), req.params.id, String(req.body?.deadlineAt ?? ""));
    res.json({ task });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to reschedule." });
  }
});

tasksRouter.delete("/:id", (req, res) => {
  try {
    deleteTask(asUser(req), req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to delete task." });
  }
});

tasksRouter.post("/match", (req, res) => {
  // Find a task by natural-language title (used by the UI for quick actions)
  try {
    const task = findTaskByTitle(asUser(req), String(req.body?.query ?? ""));
    res.json({ task });
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === "not_found") res.status(404).json({ error: err.message });
    else res.status(400).json({ error: err.message });
  }
});