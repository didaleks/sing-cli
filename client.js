"use strict";
// COPIED FROM singularity-mcp-server (upstream MCP-пакет, MIT) — client.js @ 2026-06-19 —
// не редактировать вручную, перекопировать при апдейте upstream (см. AGENTS.md → Сопровождение; LICENSE).
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiClient = void 0;
/**
 * API client for Singularity API
 */
const axios_1 = __importDefault(require("axios"));
const auth_1 = require("./utils/auth");
class ApiClient {
    /**
     * Creates a new API client
     * @param config - API client configuration
     */
    constructor(config) {
        this.baseUrl = config.baseUrl;
        this.enableLogging = config.enableLogging !== undefined ? config.enableLogging : false;
        this.logLevel = config.logLevel || 'info';
        this.interceptorsInitialized = false;
        this.client = axios_1.default.create({
            baseURL: config.baseUrl,
        });
        // Добавляем перехватчики для логирования запросов и ответов
        this.setupLoggingInterceptors();
        // Add response interceptor for error handling
        this.client.interceptors.response.use((response) => response, (error) => {
            return Promise.reject(error);
        });
    }
    /**
     * Настраивает перехватчики для логирования запросов и ответов
     */
    setupLoggingInterceptors() {
        if (!this.enableLogging || this.interceptorsInitialized)
            return;
        // Логирование запросов
        this.client.interceptors.request.use((config) => {
            this.logMessage('API Запрос', `${config.method?.toUpperCase()} ${config.url}`, {
                method: config.method?.toUpperCase(),
                url: config.url,
                params: config.params,
                data: config.data,
                headers: this.sanitizeHeaders(config.headers),
            });
            return config;
        }, (error) => {
            this.logMessage('API Ошибка запроса', error.message, {
                error: error instanceof Error ? error.message : String(error),
            });
            return Promise.reject(error);
        });
        // Логирование ответов
        this.client.interceptors.response.use((response) => {
            this.logMessage('API Ответ', `${response.config.method?.toUpperCase()} ${response.config.url}`, {
                status: response.status,
                statusText: response.statusText,
                data: response.data,
                headers: this.sanitizeHeaders(response.headers),
            });
            return response;
        }, (error) => {
            this.logMessage('API Ошибка ответа', error.message, {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                headers: error.response ? this.sanitizeHeaders(error.response.headers) : {},
                error: error instanceof Error ? error.message : String(error),
            });
            return Promise.reject(error);
        });
        this.interceptorsInitialized = true;
    }
    /**
     * Удаляет чувствительную информацию из заголовков
     */
    sanitizeHeaders(headers) {
        const sanitized = { ...headers };
        if (sanitized.Authorization) {
            sanitized.Authorization = 'Bearer [REDACTED]';
        }
        return sanitized;
    }
    /**
     * Логирует сообщение с указанным уровнем
     */
    logMessage(category, message, data) {
        if (!this.enableLogging)
            return;
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${category}] ${message}${data ? ': ' + JSON.stringify(data, null, 2) : ''}`;
        switch (this.logLevel) {
            case 'debug':
                console.debug(logMessage);
                break;
            case 'info':
                console.info(logMessage);
                break;
            case 'warn':
                console.warn(logMessage);
                break;
            case 'error':
                console.error(logMessage);
                break;
            default:
                console.log(logMessage);
        }
    }
    /**
     * Sets the access token for API requests
     * @param token - JWT access token
     */
    setAccessToken(token) {
        this.accessToken = token;
        this.logMessage('API Аутентификация', 'Установлен новый access token');
    }
    /**
     * Включает или отключает логирование
     * @param enable - Включить или выключить логирование
     */
    setLogging(enable) {
        this.enableLogging = enable;
        this.logMessage('API Конфигурация', `Логирование ${enable ? 'включено' : 'отключено'}`);
        if (enable && !this.interceptorsInitialized) {
            this.setupLoggingInterceptors();
        }
    }
    /**
     * Устанавливает уровень логирования
     * @param level - Уровень логирования
     */
    setLogLevel(level) {
        this.logLevel = level;
        this.logMessage('API Конфигурация', `Установлен уровень логирования: ${level}`);
    }
    /**
     * Creates an authenticated request config
     * @param config - Base request config
     * @returns Request config with auth headers
     */
    createRequestConfig(config) {
        const headers = this.accessToken ? (0, auth_1.createAuthHeader)(this.accessToken) : {};
        return {
            ...config,
            headers: {
                ...headers,
                ...config?.headers,
            },
        };
    }
    cleanParams(params) {
        return Object.fromEntries(Object.entries(params).filter(([_, v]) => v !== undefined && v !== null && v !== ""));
    }
    // Project methods
    /**
     * Lists projects
     * @param params - Query parameters
     * @returns List of projects
     */
    async listProjects(params = {}) {
        const response = await this.client.get('/v2/project', this.createRequestConfig({
            params: this.cleanParams({
                includeRemoved: params.includeRemoved,
                includeArchived: params.includeArchived,
                maxCount: params.maxCount,
            }),
        }));
        return response.data;
    }
    /**
     * Gets a project by ID
     * @param id - Project ID
     * @returns Project details
     */
    async getProject(id) {
        const response = await this.client.get(`/v2/project/${id}`, this.createRequestConfig());
        return response.data;
    }
    /**
     * Creates a new project
     * @param project - Project data
     * @returns Created project
     */
    async createProject(project) {
        const response = await this.client.post('/v2/project', project, this.createRequestConfig());
        return response.data;
    }
    /**
     * Updates a project
     * @param project - Project data with ID
     * @returns Updated project
     */
    async updateProject(project) {
        const response = await this.client.patch(`/v2/project/${project.id}`, project, this.createRequestConfig());
        return response.data;
    }
    /**
     * Deletes a project
     * @param id - Project ID
     */
    async deleteProject(id) {
        await this.client.delete(`/v2/project/${id}`, this.createRequestConfig());
    }
    // Task Group methods
    /**
     * Lists task groups
     * @param params - Query parameters
     * @returns List of task groups
     */
    async listTaskGroups(params) {
        const response = await this.client.get('/v2/task-group', this.createRequestConfig({ params: this.cleanParams(params ?? {}) }));
        return response.data;
    }
    /**
     * Gets a task group by ID
     * @param id - Task group ID
     * @returns Task group details
     */
    async getTaskGroup(id) {
        const response = await this.client.get(`/v2/task-group/${id}`, this.createRequestConfig());
        return response.data;
    }
    /**
     * Creates a new task group
     * @param taskGroup - Task group data
     * @returns Created task group
     */
    async createTaskGroup(taskGroup) {
        const response = await this.client.post('/v2/task-group', taskGroup, this.createRequestConfig());
        return response.data;
    }
    /**
     * Updates a task group
     * @param taskGroup - Task group data with ID
     * @returns Updated task group
     */
    async updateTaskGroup(taskGroup) {
        const response = await this.client.patch(`/v2/task-group/${taskGroup.id}`, taskGroup, this.createRequestConfig());
        return response.data;
    }
    /**
     * Deletes a task group
     * @param id - Task group ID
     */
    async deleteTaskGroup(id) {
        await this.client.delete(`/v2/task-group/${id}`, this.createRequestConfig());
    }
    // Task methods
    /**
     * Lists tasks
     * @param params - Query parameters
     * @returns List of tasks
     */
    async listTasks(params = {}) {
        const response = await this.client.get('/v2/task', this.createRequestConfig({
            params: this.cleanParams({
                includeRemoved: params.includeRemoved,
                includeArchived: params.includeArchived,
                maxCount: params.maxCount,
                projectId: params.projectId,
                parent: params.parent,
                includeAllRecurrenceInstances: params.includeAllRecurrenceInstances,
                startDateFrom: params.startDateFrom,
                startDateTo: params.startDateTo,
            }),
        }));
        return response.data;
    }
    /**
     * Gets a task by ID
     * @param id - Task ID
     * @returns Task details
     */
    async getTask(id) {
        const response = await this.client.get(`/v2/task/${id}`, this.createRequestConfig());
        return response.data;
    }
    /**
     * Creates a new task
     * @param task - Task data
     * @returns Created task
     */
    async createTask(task) {
        const response = await this.client.post('/v2/task', task, this.createRequestConfig());
        return response.data;
    }
    /**
     * Updates a task
     * @param task - Task data with ID
     * @returns Updated task
     */
    async updateTask(task) {
        const response = await this.client.patch(`/v2/task/${task.id}`, task, this.createRequestConfig());
        return response.data;
    }
    /**
     * Deletes a task
     * @param id - Task ID
     */
    async deleteTask(id) {
        await this.client.delete(`/v2/task/${id}`, this.createRequestConfig());
    }
    // Note methods
    /**
     * Lists notes
     * @param params - Query parameters
     * @returns List of notes
     */
    async listNotes(params) {
        const response = await this.client.get('/v2/note', this.createRequestConfig({ params: this.cleanParams(params ?? {}) }));
        return response.data;
    }
    /**
     * Gets a note by ID
     * @param id - Note ID
     * @returns Note details
     */
    async getNote(id) {
        const response = await this.client.get(`/v2/note/${id}`, this.createRequestConfig());
        return response.data;
    }
    /**
     * Creates a new note
     * @param note - Note data
     * @returns Created note
     */
    async createNote(note) {
        const response = await this.client.post('/v2/note', note, this.createRequestConfig());
        return response.data;
    }
    /**
     * Updates a note
     * @param note - Note data with ID
     * @returns Updated note
     */
    async updateNote(note) {
        const response = await this.client.patch(`/v2/note/${note.id}`, note, this.createRequestConfig());
        return response.data;
    }
    /**
     * Deletes a note
     * @param id - Note ID
     */
    async deleteNote(id) {
        await this.client.delete(`/v2/note/${id}`, this.createRequestConfig());
    }
    // KanbanStatus methods
    /**
     * Lists kanban statuses
     * @param params - Query parameters
     * @returns List of kanban statuses
     */
    async listKanbanStatuses(params) {
        const response = await this.client.get('/v2/kanban-status', this.createRequestConfig({ params: this.cleanParams(params ?? {}) }));
        return response.data;
    }
    /**
     * Gets a kanban status by ID
     * @param id - Kanban status ID
     * @returns Kanban status details
     */
    async getKanbanStatus(id) {
        const response = await this.client.get(`/v2/kanban-status/${id}`, this.createRequestConfig());
        return response.data;
    }
    /**
     * Creates a kanban status
     * @param kanbanStatus - Kanban status to create
     * @returns Created kanban status
     */
    async createKanbanStatus(kanbanStatus) {
        const response = await this.client.post('/v2/kanban-status', kanbanStatus, this.createRequestConfig());
        return response.data;
    }
    /**
     * Updates a kanban status
     * @param kanbanStatus - Kanban status to update
     * @returns Updated kanban status
     */
    async updateKanbanStatus(kanbanStatus) {
        const response = await this.client.patch(`/v2/kanban-status/${kanbanStatus.id}`, kanbanStatus, this.createRequestConfig());
        return response.data;
    }
    /**
     * Deletes a kanban status
     * @param id - Kanban status ID
     */
    async deleteKanbanStatus(id) {
        await this.client.delete(`/v2/kanban-status/${id}`, this.createRequestConfig());
    }
    // KanbanTaskStatus methods
    /**
     * Lists kanban task statuses
     * @param params - Query parameters
     * @returns List of kanban task statuses
     */
    async listKanbanTaskStatuses(params) {
        const response = await this.client.get('/v2/kanban-task-status', this.createRequestConfig({ params: this.cleanParams(params ?? {}) }));
        return response.data;
    }
    /**
     * Gets a kanban task status by ID
     * @param id - Kanban task status ID
     * @returns Kanban task status details
     */
    async getKanbanTaskStatus(id) {
        const response = await this.client.get(`/v2/kanban-task-status/${id}`, this.createRequestConfig());
        return response.data;
    }
    /**
     * Creates a kanban task status
     * @param kanbanTaskStatus - Kanban task status to create
     * @returns Created kanban task status
     */
    async createKanbanTaskStatus(kanbanTaskStatus) {
        const response = await this.client.post('/v2/kanban-task-status', kanbanTaskStatus, this.createRequestConfig());
        return response.data;
    }
    /**
     * Updates a kanban task status
     * @param kanbanTaskStatus - Kanban task status to update
     * @returns Updated kanban task status
     */
    async updateKanbanTaskStatus(kanbanTaskStatus) {
        const response = await this.client.patch(`/v2/kanban-task-status/${kanbanTaskStatus.id}`, kanbanTaskStatus, this.createRequestConfig());
        return response.data;
    }
    /**
     * Deletes a kanban task status
     * @param id - Kanban task status ID
     */
    async deleteKanbanTaskStatus(id) {
        await this.client.delete(`/v2/kanban-task-status/${id}`, this.createRequestConfig());
    }
    // --- HABIT ---
    async listHabits(params = {}) {
        const response = await this.client.get('/v2/habit', this.createRequestConfig({
            params: this.cleanParams({
                maxCount: params.maxCount,
            }),
        }));
        return response.data;
    }
    async getHabit(id) {
        const response = await this.client.get(`/v2/habit/${id}`, this.createRequestConfig());
        return response.data;
    }
    async createHabit(habit) {
        const response = await this.client.post('/v2/habit', habit, this.createRequestConfig());
        return response.data;
    }
    async updateHabit(habit) {
        const response = await this.client.patch(`/v2/habit/${habit.id}`, habit, this.createRequestConfig());
        return response.data;
    }
    async deleteHabit(id) {
        await this.client.delete(`/v2/habit/${id}`, this.createRequestConfig());
    }
    // --- HABIT DAILY PROGRESS ---
    async listHabitDailyProgress(params = {}) {
        const response = await this.client.get('/v2/habit-progress', this.createRequestConfig({
            params: this.cleanParams({
                maxCount: params.maxCount,
                habit: params.habit,
                startDate: params.startDate,
                endDate: params.endDate,
            }),
        }));
        return response.data;
    }
    async getHabitDailyProgress(id) {
        const response = await this.client.get(`/v2/habit-progress/${id}`, this.createRequestConfig());
        return response.data;
    }
    async createHabitDailyProgress(progress) {
        const response = await this.client.post('/v2/habit-progress', progress, this.createRequestConfig());
        return response.data;
    }
    async updateHabitDailyProgress(progress) {
        const response = await this.client.patch(`/v2/habit-progress/${progress.id}`, progress, this.createRequestConfig());
        return response.data;
    }
    async deleteHabitDailyProgress(id) {
        await this.client.delete(`/v2/habit-progress/${id}`, this.createRequestConfig());
    }
    // --- CHECKLIST ITEM ---
    async listChecklistItems(params = {}) {
        const response = await this.client.get('/v2/checklist-item', this.createRequestConfig({
            params: this.cleanParams({
                includeRemoved: params.includeRemoved,
                maxCount: params.maxCount,
                parent: params.parent,
            }),
        }));
        return response.data;
    }
    async getChecklistItem(id) {
        const response = await this.client.get(`/v2/checklist-item/${id}`, this.createRequestConfig());
        return response.data;
    }
    async createChecklistItem(item) {
        const response = await this.client.post('/v2/checklist-item', item, this.createRequestConfig());
        return response.data;
    }
    async updateChecklistItem(item) {
        const response = await this.client.patch(`/v2/checklist-item/${item.id}`, item, this.createRequestConfig());
        return response.data;
    }
    async deleteChecklistItem(id) {
        await this.client.delete(`/v2/checklist-item/${id}`, this.createRequestConfig());
    }
    // --- TAG ---
    async listTags(params = {}) {
        const response = await this.client.get('/v2/tag', this.createRequestConfig({
            params: this.cleanParams({
                includeRemoved: params.includeRemoved,
                maxCount: params.maxCount,
                parent: params.parent,
            }),
        }));
        return response.data;
    }
    // TIME STAT METHODS
    async createTimeStat(timeStat) {
        const response = await this.client.post('/v2/time-stat', timeStat, this.createRequestConfig());
        return response.data;
    }
    async updateTimeStat(timeStat) {
        const { id, ...updateData } = timeStat;
        const response = await this.client.patch(`/v2/time-stat/${id}`, updateData, this.createRequestConfig());
        return response.data;
    }
    async deleteTimeStat(id) {
        await this.client.delete(`/v2/time-stat/${id}`, this.createRequestConfig());
    }
    async getTimeStat(id) {
        const response = await this.client.get(`/v2/time-stat/${id}`, this.createRequestConfig());
        return response.data;
    }
    async listTimeStats(params = {}) {
        const response = await this.client.get('/v2/time-stat', this.createRequestConfig({
            params: this.cleanParams({
                dateFrom: params.dateFrom,
                dateTo: params.dateTo,
                relatedTaskId: params.relatedTaskId,
                maxCount: params.maxCount,
            }),
        }));
        return response.data;
    }
    async deleteBulkTimeStats(params) {
        const response = await this.client.delete('/v2/time-stat', this.createRequestConfig({
            params: this.cleanParams({
                dateFrom: params.dateFrom,
                dateTo: params.dateTo,
                relatedTaskId: params.relatedTaskId,
            }),
        }));
        return response.data;
    }
    async getTag(id) {
        const response = await this.client.get(`/v2/tag/${id}`, this.createRequestConfig());
        return response.data;
    }
    async createTag(tag) {
        const response = await this.client.post('/v2/tag', tag, this.createRequestConfig());
        return response.data;
    }
    async updateTag(tag) {
        const response = await this.client.patch(`/v2/tag/${tag.id}`, tag, this.createRequestConfig());
        return response.data;
    }
    async deleteTag(id) {
        await this.client.delete(`/v2/tag/${id}`, this.createRequestConfig());
    }
}
exports.ApiClient = ApiClient;
//# sourceMappingURL=client.js.map