#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import fetch from 'node-fetch';

class GitLabMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'gitlab-mcp-server',
        version: '0.0.1',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  // Метод для поиска Git репозитория вверх по иерархии директорий
  findGitRepository(startPath = process.cwd()) {
    let currentPath = startPath;

    while (currentPath !== dirname(currentPath)) {
      const gitPath = join(currentPath, '.git');
      if (existsSync(gitPath)) {
        return currentPath;
      }
      currentPath = dirname(currentPath);
    }

    return null;
  }

  // Метод для проверки, является ли URL GitLab репозиторием
  isGitLabRepository(url) {
    if (!url || typeof url !== 'string') {
      return false;
    }

    // Нормализуем URL (убираем .git в конце если есть)
    const normalizedUrl = url.replace(/\.git$/, '');

    // Проверяем различные форматы GitLab URL
    const gitlabPatterns = [
      // HTTPS формат: https://gitlab.com/... или https://gitlab.example.com/...
      /^https:\/\/([a-zA-Z0-9.-]*gitlab[a-zA-Z0-9.-]*|gitlab\.com)\//,
      // SSH формат: git@gitlab.com:... или git@gitlab.example.com:...
      /^git@([a-zA-Z0-9.-]*gitlab[a-zA-Z0-9.-]*|gitlab\.com):/,
      // Альтернативный SSH формат: ssh://git@gitlab.com/...
      /^ssh:\/\/git@([a-zA-Z0-9.-]*gitlab[a-zA-Z0-9.-]*|gitlab\.com)\//,
    ];

    return gitlabPatterns.some(pattern => pattern.test(normalizedUrl));
  }

  // Метод для извлечения информации о GitLab проекте из URL
  parseGitLabUrl(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }

    // Нормализуем URL
    let normalizedUrl = url.replace(/\.git$/, '');

    // Обрабатываем SSH формат: git@gitlab.com:username/repo -> https://gitlab.com/username/repo
    if (normalizedUrl.startsWith('git@')) {
      normalizedUrl = normalizedUrl.replace(/^git@([^:]+):/, 'https://$1/');
    }

    // Обрабатываем ssh:// формат
    if (normalizedUrl.startsWith('ssh://git@')) {
      normalizedUrl = normalizedUrl.replace(/^ssh:\/\/git@/, 'https://');
    }

    try {
      const urlObj = new URL(normalizedUrl);
      const pathParts = urlObj.pathname.split('/').filter(part => part);

      if (pathParts.length >= 2) {
        return {
          host: urlObj.host,
          namespace: pathParts.slice(0, -1).join('/'),
          project: pathParts[pathParts.length - 1],
          projectId: encodeURIComponent(pathParts.join('/'))
        };
      }
    } catch (error) {
      console.error('Ошибка при парсинге URL:', error);
    }

    return null;
  }

  // Метод для получения подробной информации о пайплайне
  async getPipelineDetails(projectPath, pipelineId = null) {
    try {
      // Получаем URL репозитория
      const gitRepoPath = this.findGitRepository(projectPath);
      if (!gitRepoPath) {
        throw new Error(`Git репозиторий не найден в указанной директории: ${projectPath}`);
      }

      const repoUrl = execSync('git remote get-url origin', {
        encoding: 'utf8',
        cwd: gitRepoPath
      }).trim();

      // Проверяем, что это GitLab репозиторий
      if (!this.isGitLabRepository(repoUrl)) {
        throw new Error(`Это не GitLab репозиторий: ${repoUrl}`);
      }

      // Парсим URL для получения информации о проекте
      const gitlabInfo = this.parseGitLabUrl(repoUrl);
      if (!gitlabInfo) {
        throw new Error(`Не удалось распарсить GitLab URL: ${repoUrl}`);
      }

      // Проверяем наличие токена
      const gitlabToken = process.env.GITLAB_TOKEN;
      if (!gitlabToken) {
        throw new Error('GITLAB_TOKEN не установлен. Установите переменную окружения GITLAB_TOKEN для доступа к GitLab API.');
      }

      // Если pipelineId не указан, получаем последний пайплайн
      let targetPipelineId = pipelineId;
      if (!targetPipelineId) {
        const latestPipelineUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/pipelines?per_page=1&order_by=updated_at&sort=desc`;

        const latestResponse = await fetch(latestPipelineUrl, {
          headers: {
            'Authorization': `Bearer ${gitlabToken}`,
            'Content-Type': 'application/json'
          }
        });

        if (!latestResponse.ok) {
          const errorText = await latestResponse.text();
          throw new Error(`GitLab API вернул ошибку при получении последнего пайплайна ${latestResponse.status}: ${errorText}`);
        }

        const latestPipelines = await latestResponse.json();
        if (!latestPipelines || latestPipelines.length === 0) {
          return {
            success: true,
            message: 'Пайплайны не найдены',
            data: null
          };
        }

        targetPipelineId = latestPipelines[0].id;
      }

      // Получаем подробную информацию о пайплайне
      const pipelineUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/pipelines/${targetPipelineId}`;
      const pipelineResponse = await fetch(pipelineUrl, {
        headers: {
          'Authorization': `Bearer ${gitlabToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!pipelineResponse.ok) {
        const errorText = await pipelineResponse.text();
        throw new Error(`GitLab API вернул ошибку при получении пайплайна ${pipelineResponse.status}: ${errorText}`);
      }

      const pipeline = await pipelineResponse.json();

      // Получаем джобы пайплайна
      const jobsUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/pipelines/${targetPipelineId}/jobs`;
      const jobsResponse = await fetch(jobsUrl, {
        headers: {
          'Authorization': `Bearer ${gitlabToken}`,
          'Content-Type': 'application/json'
        }
      });

      let jobs = [];
      if (jobsResponse.ok) {
        jobs = await jobsResponse.json();
      }

      // Получаем артефакты пайплайна
      const artifactsUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/pipelines/${targetPipelineId}/artifacts`;
      const artifactsResponse = await fetch(artifactsUrl, {
        headers: {
          'Authorization': `Bearer ${gitlabToken}`,
          'Content-Type': 'application/json'
        }
      });

      let artifacts = [];
      if (artifactsResponse.ok) {
        artifacts = await artifactsResponse.json();
      }

      // Для каждого джоба получаем trace (логи)
      const jobsWithLogs = await Promise.all(jobs.map(async (job) => {
        try {
          const traceUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/jobs/${job.id}/trace`;
          const traceResponse = await fetch(traceUrl, {
            headers: {
              'Authorization': `Bearer ${gitlabToken}`,
              'Content-Type': 'application/json'
            }
          });

          let trace = '';
          if (traceResponse.ok) {
            trace = await traceResponse.text();
          }

          return {
            ...job,
            trace: trace
          };
        } catch (error) {
          console.error(`Ошибка при получении trace для джоба ${job.id}:`, error.message);
          return {
            ...job,
            trace: `Ошибка при получении логов: ${error.message}`
          };
        }
      }));

      return {
        success: true,
        message: 'Подробная информация о пайплайне получена успешно',
        data: {
          pipeline: {
            id: pipeline.id,
            status: pipeline.status,
            ref: pipeline.ref,
            sha: pipeline.sha,
            web_url: pipeline.web_url,
            created_at: pipeline.created_at,
            updated_at: pipeline.updated_at,
            duration: pipeline.duration,
            coverage: pipeline.coverage,
            source: pipeline.source,
            before_sha: pipeline.before_sha,
            tag: pipeline.tag,
            yaml_errors: pipeline.yaml_errors,
            user: pipeline.user,
            project: {
              host: gitlabInfo.host,
              namespace: gitlabInfo.namespace,
              name: gitlabInfo.project
            }
          },
          jobs: jobsWithLogs,
          artifacts: artifacts
        }
      };

    } catch (error) {
      return {
        success: false,
        message: error.message,
        data: null
      };
    }
  }

  // Метод для получения информации о конкретном джобе
  async getJobDetails(projectPath, jobId) {
    try {
      // Получаем URL репозитория
      const gitRepoPath = this.findGitRepository(projectPath);
      if (!gitRepoPath) {
        throw new Error(`Git репозиторий не найден в указанной директории: ${projectPath}`);
      }

      const repoUrl = execSync('git remote get-url origin', {
        encoding: 'utf8',
        cwd: gitRepoPath
      }).trim();

      // Проверяем, что это GitLab репозиторий
      if (!this.isGitLabRepository(repoUrl)) {
        throw new Error(`Это не GitLab репозиторий: ${repoUrl}`);
      }

      // Парсим URL для получения информации о проекте
      const gitlabInfo = this.parseGitLabUrl(repoUrl);
      if (!gitlabInfo) {
        throw new Error(`Не удалось распарсить GitLab URL: ${repoUrl}`);
      }

      // Проверяем наличие токена
      const gitlabToken = process.env.GITLAB_TOKEN;
      if (!gitlabToken) {
        throw new Error('GITLAB_TOKEN не установлен. Установите переменную окружения GITLAB_TOKEN для доступа к GitLab API.');
      }

      // Получаем информацию о джобе
      const jobUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/jobs/${jobId}`;
      const jobResponse = await fetch(jobUrl, {
        headers: {
          'Authorization': `Bearer ${gitlabToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!jobResponse.ok) {
        const errorText = await jobResponse.text();
        throw new Error(`GitLab API вернул ошибку при получении джоба ${jobResponse.status}: ${errorText}`);
      }

      const job = await jobResponse.json();

      return {
        success: true,
        message: 'Информация о джобе получена успешно',
        data: {
          job: job,
          project: {
            host: gitlabInfo.host,
            namespace: gitlabInfo.namespace,
            name: gitlabInfo.project
          }
        }
      };

    } catch (error) {
      return {
        success: false,
        message: error.message,
        data: null
      };
    }
  }

  // Метод для получения логов конкретного джоба
  async getJobLogs(projectPath, jobId) {
    try {
      // Получаем URL репозитория
      const gitRepoPath = this.findGitRepository(projectPath);
      if (!gitRepoPath) {
        throw new Error(`Git репозиторий не найден в указанной директории: ${projectPath}`);
      }

      const repoUrl = execSync('git remote get-url origin', {
        encoding: 'utf8',
        cwd: gitRepoPath
      }).trim();

      // Проверяем, что это GitLab репозиторий
      if (!this.isGitLabRepository(repoUrl)) {
        throw new Error(`Это не GitLab репозиторий: ${repoUrl}`);
      }

      // Парсим URL для получения информации о проекте
      const gitlabInfo = this.parseGitLabUrl(repoUrl);
      if (!gitlabInfo) {
        throw new Error(`Не удалось распарсить GitLab URL: ${repoUrl}`);
      }

      // Проверяем наличие токена
      const gitlabToken = process.env.GITLAB_TOKEN;
      if (!gitlabToken) {
        throw new Error('GITLAB_TOKEN не установлен. Установите переменную окружения GITLAB_TOKEN для доступа к GitLab API.');
      }

      // Получаем информацию о джобе
      const jobUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/jobs/${jobId}`;
      const jobResponse = await fetch(jobUrl, {
        headers: {
          'Authorization': `Bearer ${gitlabToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!jobResponse.ok) {
        const errorText = await jobResponse.text();
        throw new Error(`GitLab API вернул ошибку при получении джоба ${jobResponse.status}: ${errorText}`);
      }

      const job = await jobResponse.json();

      // Получаем логи джоба
      const traceUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/jobs/${jobId}/trace`;
      const traceResponse = await fetch(traceUrl, {
        headers: {
          'Authorization': `Bearer ${gitlabToken}`,
          'Content-Type': 'application/json'
        }
      });

      let trace = '';
      if (traceResponse.ok) {
        trace = await traceResponse.text();
      }

      return {
        success: true,
        message: 'Логи джоба получены успешно',
        data: {
          job: job,
          logs: trace,
          project: {
            host: gitlabInfo.host,
            namespace: gitlabInfo.namespace,
            name: gitlabInfo.project
          }
        }
      };

    } catch (error) {
      return {
        success: false,
        message: error.message,
        data: null
      };
    }
  }

  // Метод для получения артефактов конкретного джоба
  async getJobArtifacts(projectPath, jobId) {
    try {
      // Получаем URL репозитория
      const gitRepoPath = this.findGitRepository(projectPath);
      if (!gitRepoPath) {
        throw new Error(`Git репозиторий не найден в указанной директории: ${projectPath}`);
      }

      const repoUrl = execSync('git remote get-url origin', {
        encoding: 'utf8',
        cwd: gitRepoPath
      }).trim();

      // Проверяем, что это GitLab репозиторий
      if (!this.isGitLabRepository(repoUrl)) {
        throw new Error(`Это не GitLab репозиторий: ${repoUrl}`);
      }

      // Парсим URL для получения информации о проекте
      const gitlabInfo = this.parseGitLabUrl(repoUrl);
      if (!gitlabInfo) {
        throw new Error(`Не удалось распарсить GitLab URL: ${repoUrl}`);
      }

      // Проверяем наличие токена
      const gitlabToken = process.env.GITLAB_TOKEN;
      if (!gitlabToken) {
        throw new Error('GITLAB_TOKEN не установлен. Установите переменную окружения GITLAB_TOKEN для доступа к GitLab API.');
      }

      // Получаем информацию о джобе
      const jobUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/jobs/${jobId}`;
      const jobResponse = await fetch(jobUrl, {
        headers: {
          'Authorization': `Bearer ${gitlabToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!jobResponse.ok) {
        const errorText = await jobResponse.text();
        throw new Error(`GitLab API вернул ошибку при получении джоба ${jobResponse.status}: ${errorText}`);
      }

      const job = await jobResponse.json();

      // Получаем артефакты джоба
      const artifactsUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/jobs/${jobId}/artifacts`;
      const artifactsResponse = await fetch(artifactsUrl, {
        headers: {
          'Authorization': `Bearer ${gitlabToken}`,
          'Content-Type': 'application/json'
        }
      });

      let artifacts = [];
      if (artifactsResponse.ok) {
        // Для артефактов получаем список файлов
        const artifactsListUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/jobs/${jobId}/artifacts`;
        const artifactsListResponse = await fetch(artifactsListUrl, {
          headers: {
            'Authorization': `Bearer ${gitlabToken}`,
            'Content-Type': 'application/json'
          }
        });

        if (artifactsListResponse.ok) {
          // GitLab API возвращает архив артефактов, но мы можем получить информацию о них из джоба
          artifacts = job.artifacts || [];
        }
      }

      return {
        success: true,
        message: 'Артефакты джоба получены успешно',
        data: {
          job: job,
          artifacts: artifacts,
          project: {
            host: gitlabInfo.host,
            namespace: gitlabInfo.namespace,
            name: gitlabInfo.project
          }
        }
      };

    } catch (error) {
      return {
        success: false,
        message: error.message,
        data: null
      };
    }
  }

  // Метод для получения последнего пайплайна через GitLab API
  async getLatestPipeline(projectPath) {
    try {
      // Получаем URL репозитория
      const gitRepoPath = this.findGitRepository(projectPath);
      if (!gitRepoPath) {
        throw new Error(`Git репозиторий не найден в указанной директории: ${projectPath}`);
      }

      const repoUrl = execSync('git remote get-url origin', {
        encoding: 'utf8',
        cwd: gitRepoPath
      }).trim();

      // Проверяем, что это GitLab репозиторий
      if (!this.isGitLabRepository(repoUrl)) {
        throw new Error(`Это не GitLab репозиторий: ${repoUrl}`);
      }

      // Парсим URL для получения информации о проекте
      const gitlabInfo = this.parseGitLabUrl(repoUrl);
      if (!gitlabInfo) {
        throw new Error(`Не удалось распарсить GitLab URL: ${repoUrl}`);
      }

      // Проверяем наличие токена
      const gitlabToken = process.env.GITLAB_TOKEN;
      if (!gitlabToken) {
        throw new Error('GITLAB_TOKEN не установлен. Установите переменную окружения GITLAB_TOKEN для доступа к GitLab API.');
      }

      // Формируем URL для API запроса
      const apiUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/pipelines?per_page=1&order_by=updated_at&sort=desc`;

      console.error(`DEBUG: Запрос к GitLab API: ${apiUrl}`);

      // Выполняем запрос к GitLab API
      const response = await fetch(apiUrl, {
        headers: {
          'Authorization': `Bearer ${gitlabToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitLab API вернул ошибку ${response.status}: ${errorText}`);
      }

      const pipelines = await response.json();

      if (!pipelines || pipelines.length === 0) {
        return {
          success: true,
          message: 'Пайплайны не найдены',
          data: null
        };
      }

      const latestPipeline = pipelines[0];

      return {
        success: true,
        message: 'Последний пайплайн получен успешно',
        data: {
          id: latestPipeline.id,
          status: latestPipeline.status,
          ref: latestPipeline.ref,
          sha: latestPipeline.sha,
          web_url: latestPipeline.web_url,
          created_at: latestPipeline.created_at,
          updated_at: latestPipeline.updated_at,
          duration: latestPipeline.duration,
          coverage: latestPipeline.coverage,
          project: {
            host: gitlabInfo.host,
            namespace: gitlabInfo.namespace,
            name: gitlabInfo.project
          }
        }
      };

    } catch (error) {
      return {
        success: false,
        message: error.message,
        data: null
      };
    }
  }

  // Метод для скачивания артефактов конкретного джоба
  async downloadJobArtifacts(projectPath, jobId, downloadPath = null) {
    try {
      // Получаем URL репозитория
      const gitRepoPath = this.findGitRepository(projectPath);
      if (!gitRepoPath) {
        throw new Error(`Git репозиторий не найден в указанной директории: ${projectPath}`);
      }

      const repoUrl = execSync('git remote get-url origin', {
        encoding: 'utf8',
        cwd: gitRepoPath
      }).trim();

      // Проверяем, что это GitLab репозиторий
      if (!this.isGitLabRepository(repoUrl)) {
        throw new Error(`Это не GitLab репозиторий: ${repoUrl}`);
      }

      // Парсим URL для получения информации о проекте
      const gitlabInfo = this.parseGitLabUrl(repoUrl);
      if (!gitlabInfo) {
        throw new Error(`Не удалось распарсить GitLab URL: ${repoUrl}`);
      }

      // Проверяем наличие токена
      const gitlabToken = process.env.GITLAB_TOKEN;
      if (!gitlabToken) {
        throw new Error('GITLAB_TOKEN не установлен. Установите переменную окружения GITLAB_TOKEN для доступа к GitLab API.');
      }

      // Получаем информацию о джобе
      const jobUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/jobs/${jobId}`;
      const jobResponse = await fetch(jobUrl, {
        headers: {
          'Authorization': `Bearer ${gitlabToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!jobResponse.ok) {
        const errorText = await jobResponse.text();
        throw new Error(`GitLab API вернул ошибку при получении джоба ${jobResponse.status}: ${errorText}`);
      }

      const job = await jobResponse.json();

      // Проверяем, есть ли артефакты у джоба
      if (!job.artifacts_file || !job.artifacts_file.filename) {
        return {
          success: true,
          message: 'У джоба нет артефактов для скачивания',
          data: {
            job: job,
            downloadedFiles: [],
            downloadPath: null
          }
        };
      }

      // Определяем путь для скачивания
      let targetDownloadPath = downloadPath;
      if (!targetDownloadPath) {
        // Создаем папку artifacts в директории проекта
        targetDownloadPath = join(projectPath, 'artifacts', `job_${jobId}`);
      }

      // Создаем директорию если она не существует
      if (!existsSync(targetDownloadPath)) {
        mkdirSync(targetDownloadPath, { recursive: true });
      }

      // Скачиваем артефакты джоба (это ZIP архив)
      const artifactsUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/jobs/${jobId}/artifacts`;
      const artifactsResponse = await fetch(artifactsUrl, {
        headers: {
          'Authorization': `Bearer ${gitlabToken}`
        }
      });

      if (!artifactsResponse.ok) {
        const errorText = await artifactsResponse.text();
        throw new Error(`GitLab API вернул ошибку при скачивании артефактов ${artifactsResponse.status}: ${errorText}`);
      }

      // Получаем содержимое архива
      const artifactsBuffer = await artifactsResponse.buffer();
      
      // Сохраняем архив
      const archiveFileName = `artifacts_job_${jobId}.zip`;
      const archivePath = join(targetDownloadPath, archiveFileName);
      writeFileSync(archivePath, artifactsBuffer);

      return {
        success: true,
        message: 'Артефакты джоба скачаны успешно',
        data: {
          job: job,
          downloadedFiles: [archiveFileName],
          downloadPath: targetDownloadPath,
          archivePath: archivePath,
          archiveSize: artifactsBuffer.length
        }
      };

    } catch (error) {
      return {
        success: false,
        message: error.message,
        data: null
      };
    }
  }

  // Метод для скачивания артефактов пайплайна
  async downloadPipelineArtifacts(projectPath, pipelineId = null, downloadPath = null) {
    try {
      // Получаем URL репозитория
      const gitRepoPath = this.findGitRepository(projectPath);
      if (!gitRepoPath) {
        throw new Error(`Git репозиторий не найден в указанной директории: ${projectPath}`);
      }

      const repoUrl = execSync('git remote get-url origin', {
        encoding: 'utf8',
        cwd: gitRepoPath
      }).trim();

      // Проверяем, что это GitLab репозиторий
      if (!this.isGitLabRepository(repoUrl)) {
        throw new Error(`Это не GitLab репозиторий: ${repoUrl}`);
      }

      // Парсим URL для получения информации о проекте
      const gitlabInfo = this.parseGitLabUrl(repoUrl);
      if (!gitlabInfo) {
        throw new Error(`Не удалось распарсить GitLab URL: ${repoUrl}`);
      }

      // Проверяем наличие токена
      const gitlabToken = process.env.GITLAB_TOKEN;
      if (!gitlabToken) {
        throw new Error('GITLAB_TOKEN не установлен. Установите переменную окружения GITLAB_TOKEN для доступа к GitLab API.');
      }

      // Если pipelineId не указан, получаем последний пайплайн
      let targetPipelineId = pipelineId;
      if (!targetPipelineId) {
        const latestPipelineUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/pipelines?per_page=1&order_by=updated_at&sort=desc`;

        const latestResponse = await fetch(latestPipelineUrl, {
          headers: {
            'Authorization': `Bearer ${gitlabToken}`,
            'Content-Type': 'application/json'
          }
        });

        if (!latestResponse.ok) {
          const errorText = await latestResponse.text();
          throw new Error(`GitLab API вернул ошибку при получении последнего пайплайна ${latestResponse.status}: ${errorText}`);
        }

        const latestPipelines = await latestResponse.json();
        if (!latestPipelines || latestPipelines.length === 0) {
          return {
            success: true,
            message: 'Пайплайны не найдены',
            data: null
          };
        }

        targetPipelineId = latestPipelines[0].id;
      }

      // Получаем джобы пайплайна
      const jobsUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/pipelines/${targetPipelineId}/jobs`;
      const jobsResponse = await fetch(jobsUrl, {
        headers: {
          'Authorization': `Bearer ${gitlabToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!jobsResponse.ok) {
        const errorText = await jobsResponse.text();
        throw new Error(`GitLab API вернул ошибку при получении джобов пайплайна ${jobsResponse.status}: ${errorText}`);
      }

      const jobs = await jobsResponse.json();

      // Фильтруем джобы, у которых есть артефакты
      const jobsWithArtifacts = jobs.filter(job => job.artifacts_file && job.artifacts_file.filename);

      if (jobsWithArtifacts.length === 0) {
        return {
          success: true,
          message: 'В пайплайне нет джобов с артефактами',
          data: {
            pipelineId: targetPipelineId,
            jobs: jobs,
            downloadedFiles: [],
            downloadPath: null
          }
        };
      }

      // Определяем путь для скачивания
      let targetDownloadPath = downloadPath;
      if (!targetDownloadPath) {
        // Создаем папку artifacts в директории проекта
        targetDownloadPath = join(projectPath, 'artifacts', `pipeline_${targetPipelineId}`);
      }

      // Создаем директорию если она не существует
      if (!existsSync(targetDownloadPath)) {
        mkdirSync(targetDownloadPath, { recursive: true });
      }

      const downloadedFiles = [];
      const downloadResults = [];

      // Скачиваем артефакты для каждого джоба
      for (const job of jobsWithArtifacts) {
        try {
          const artifactsUrl = `https://${gitlabInfo.host}/api/v4/projects/${gitlabInfo.projectId}/jobs/${job.id}/artifacts`;
          const artifactsResponse = await fetch(artifactsUrl, {
            headers: {
              'Authorization': `Bearer ${gitlabToken}`
            }
          });

          if (artifactsResponse.ok) {
            const artifactsBuffer = await artifactsResponse.buffer();
            const archiveFileName = `artifacts_job_${job.id}_${job.name.replace(/[^a-zA-Z0-9]/g, '_')}.zip`;
            const archivePath = join(targetDownloadPath, archiveFileName);
            
            writeFileSync(archivePath, artifactsBuffer);
            downloadedFiles.push(archiveFileName);
            
            downloadResults.push({
              jobId: job.id,
              jobName: job.name,
              fileName: archiveFileName,
              size: artifactsBuffer.length,
              success: true
            });
          } else {
            downloadResults.push({
              jobId: job.id,
              jobName: job.name,
              fileName: null,
              size: 0,
              success: false,
              error: `HTTP ${artifactsResponse.status}`
            });
          }
        } catch (error) {
          downloadResults.push({
            jobId: job.id,
            jobName: job.name,
            fileName: null,
            size: 0,
            success: false,
            error: error.message
          });
        }
      }

      return {
        success: true,
        message: `Артефакты пайплайна скачаны. Успешно: ${downloadResults.filter(r => r.success).length}, Ошибок: ${downloadResults.filter(r => !r.success).length}`,
        data: {
          pipelineId: targetPipelineId,
          jobs: jobs,
          jobsWithArtifacts: jobsWithArtifacts,
          downloadedFiles: downloadedFiles,
          downloadPath: targetDownloadPath,
          downloadResults: downloadResults
        }
      };

    } catch (error) {
      return {
        success: false,
        message: error.message,
        data: null
      };
    }
  }

  setupToolHandlers() {
    // Обработчик для получения списка доступных тулз
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'get_repo_url',
            description: 'Получает URL текущего Git репозитория. ОБЯЗАТЕЛЬНО передай путь до директории проекта из которого вызываешь тулзу в параметре project_path',
            inputSchema: {
              type: 'object',
              properties: {
                project_path: {
                  type: 'string',
                  description: 'Путь к директории проекта (ОБЯЗАТЕЛЬНО). ИИ агент должен передать полный путь к директории проекта, из которого он работает',
                },
              },
              required: ['project_path'],
            },
          },
          {
            name: 'get_latest_pipeline',
            description: 'Получает информацию о последнем пайплайне GitLab для текущего репозитория',
            inputSchema: {
              type: 'object',
              properties: {
                project_path: {
                  type: 'string',
                  description: 'Путь к директории проекта (ОБЯЗАТЕЛЬНО). ИИ агент должен передать полный путь к директории проекта, из которого он работает',
                },
              },
              required: ['project_path'],
            },
          },
          {
            name: 'get_pipeline_details',
            description: 'Получает подробную информацию о пайплайне GitLab включая джобы, логи, артефакты и trace. Помогает ИИ агенту диагностировать проблемы в пайплайнах.',
            inputSchema: {
              type: 'object',
              properties: {
                project_path: {
                  type: 'string',
                  description: 'Путь к директории проекта (ОБЯЗАТЕЛЬНО). ИИ агент должен передать полный путь к директории проекта, из которого он работает',
                },
                pipeline_id: {
                  type: 'string',
                  description: 'ID конкретного пайплайна (опционально). Если не указан, будет получен последний пайплайн',
                },
              },
              required: ['project_path'],
            },
          },
          {
            name: 'get_job_details',
            description: 'Получает подробную информацию о конкретном джобе GitLab по его ID',
            inputSchema: {
              type: 'object',
              properties: {
                project_path: {
                  type: 'string',
                  description: 'Путь к директории проекта (ОБЯЗАТЕЛЬНО). ИИ агент должен передать полный путь к директории проекта, из которого он работает',
                },
                job_id: {
                  type: 'string',
                  description: 'ID джоба (ОБЯЗАТЕЛЬНО). Можно получить из get_pipeline_details',
                },
              },
              required: ['project_path', 'job_id'],
            },
          },
          {
            name: 'get_job_logs',
            description: 'Получает логи (trace) конкретного джоба GitLab по его ID. Полезно для диагностики проблем в джобах.',
            inputSchema: {
              type: 'object',
              properties: {
                project_path: {
                  type: 'string',
                  description: 'Путь к директории проекта (ОБЯЗАТЕЛЬНО). ИИ агент должен передать полный путь к директории проекта, из которого он работает',
                },
                job_id: {
                  type: 'string',
                  description: 'ID джоба (ОБЯЗАТЕЛЬНО). Можно получить из get_pipeline_details',
                },
              },
              required: ['project_path', 'job_id'],
            },
          },
          {
            name: 'get_job_artifacts',
            description: 'Получает информацию об артефактах конкретного джоба GitLab по его ID',
            inputSchema: {
              type: 'object',
              properties: {
                project_path: {
                  type: 'string',
                  description: 'Путь к директории проекта (ОБЯЗАТЕЛЬНО). ИИ агент должен передать полный путь к директории проекта, из которого он работает',
                },
                job_id: {
                  type: 'string',
                  description: 'ID джоба (ОБЯЗАТЕЛЬНО). Можно получить из get_pipeline_details',
                },
              },
              required: ['project_path', 'job_id'],
            },
          },
          {
            name: 'download_job_artifacts',
            description: 'Скачивает артефакты конкретного джоба GitLab в виде ZIP архива для дальнейшего исследования',
            inputSchema: {
              type: 'object',
              properties: {
                project_path: {
                  type: 'string',
                  description: 'Путь к директории проекта (ОБЯЗАТЕЛЬНО). ИИ агент должен передать полный путь к директории проекта, из которого он работает',
                },
                job_id: {
                  type: 'string',
                  description: 'ID джоба (ОБЯЗАТЕЛЬНО). Можно получить из get_pipeline_details',
                },
                download_path: {
                  type: 'string',
                  description: 'Путь для сохранения артефактов (опционально). Если не указан, будет создана папка artifacts/job_ID в директории проекта',
                },
              },
              required: ['project_path', 'job_id'],
            },
          },
          {
            name: 'download_pipeline_artifacts',
            description: 'Скачивает артефакты всех джобов пайплайна GitLab в виде ZIP архивов для дальнейшего исследования',
            inputSchema: {
              type: 'object',
              properties: {
                project_path: {
                  type: 'string',
                  description: 'Путь к директории проекта (ОБЯЗАТЕЛЬНО). ИИ агент должен передать полный путь к директории проекта, из которого он работает',
                },
                pipeline_id: {
                  type: 'string',
                  description: 'ID пайплайна (опционально). Если не указан, будет использован последний пайплайн',
                },
                download_path: {
                  type: 'string',
                  description: 'Путь для сохранения артефактов (опционально). Если не указан, будет создана папка artifacts/pipeline_ID в директории проекта',
                },
              },
              required: ['project_path'],
            },
          },
        ],
      };
    });

    // Обработчик для выполнения тулз
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === 'get_repo_url') {
        try {
          // Получаем обязательный путь к проекту от ИИ агента
          const rawProjectPath = request.params.arguments?.project_path;

          if (!rawProjectPath) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Параметр project_path обязателен! ИИ агент должен передать полный путь к директории проекта, из которого он работает.\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          // Нормализуем путь для кроссплатформенности
          const projectPath = resolve(rawProjectPath);
          const currentWorkingDir = process.cwd();

          // Отладочная информация
          console.error(`DEBUG: rawProjectPath = ${rawProjectPath}`);
          console.error(`DEBUG: projectPath = ${projectPath}`);
          console.error(`DEBUG: currentWorkingDir = ${currentWorkingDir}`);
          console.error(`DEBUG: arguments = ${JSON.stringify(request.params.arguments)}`);

          // Ищем Git репозиторий в указанной директории или выше
          const gitRepoPath = this.findGitRepository(projectPath);

          if (!gitRepoPath) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Git репозиторий не найден в указанной директории: ${projectPath}\nИсходный путь: ${rawProjectPath}\nРабочая директория MCP сервера: ${currentWorkingDir}\n\nПодсказка: Убедитесь, что передаете правильный путь к директории проекта в параметре project_path`,
                },
              ],
            };
          }

          // Выполняем команду git для получения URL репозитория
          const repoUrl = execSync('git remote get-url origin', {
            encoding: 'utf8',
            cwd: gitRepoPath
          }).trim();

          // Проверяем, является ли URL GitLab репозиторием
          const isGitLabUrl = this.isGitLabRepository(repoUrl);

          if (!isGitLabUrl) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Это не GitLab репозиторий!\n\nURL репозитория: ${repoUrl}\n\nЭтот MCP сервер предназначен для работы только с GitLab репозиториями.\nПоддерживаемые форматы GitLab URL:\n- https://gitlab.com/username/repo.git\n- https://gitlab.example.com/username/repo.git\n- git@gitlab.com:username/repo.git\n- git@gitlab.example.com:username/repo.git\n\nПуть к репозиторию: ${gitRepoPath}\nУказанная директория проекта: ${projectPath}`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: 'text',
                text: `✅ GitLab репозиторий найден!\nURL: ${repoUrl}\nПуть к репозиторию: ${gitRepoPath}\nУказанная директория проекта: ${projectPath}\nРабочая директория MCP сервера: ${currentWorkingDir}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Ошибка при получении URL репозитория: ${error.message}. Убедитесь, что настроен remote origin.\nУказанная директория проекта: ${request.params.arguments?.project_path || 'НЕ УКАЗАНА'}\nРабочая директория MCP сервера: ${process.cwd()}`,
              },
            ],
          };
        }
      }


      if (request.params.name === 'get_latest_pipeline') {
        try {
          // Получаем обязательный путь к проекту от ИИ агента
          const rawProjectPath = request.params.arguments?.project_path;

          if (!rawProjectPath) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Параметр project_path обязателен! ИИ агент должен передать полный путь к директории проекта, из которого он работает.\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          // Нормализуем путь для кроссплатформенности
          const projectPath = resolve(rawProjectPath);

          // Получаем информацию о последнем пайплайне
          const result = await this.getLatestPipeline(projectPath);

          if (!result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: ${result.message}\n\nУказанная директория проекта: ${projectPath}\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          if (!result.data) {
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ ${result.message}\n\nУказанная директория проекта: ${projectPath}\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          const pipeline = result.data;
          const statusEmoji = {
            'success': '✅',
            'failed': '❌',
            'running': '🔄',
            'pending': '⏳',
            'canceled': '⏹️',
            'skipped': '⏭️',
            'manual': '👤'
          };

          const emoji = statusEmoji[pipeline.status] || '❓';

          return {
            content: [
              {
                type: 'text',
                text: `🎯 **Последний пайплайн GitLab**

${emoji} **Статус:** ${pipeline.status.toUpperCase()}
🆔 **ID:** ${pipeline.id}
🌿 **Ветка:** ${pipeline.ref}
📝 **SHA:** ${pipeline.sha.substring(0, 8)}
🔗 **Ссылка:** ${pipeline.web_url}
📅 **Создан:** ${new Date(pipeline.created_at).toLocaleString('ru-RU')}
🔄 **Обновлен:** ${new Date(pipeline.updated_at).toLocaleString('ru-RU')}
${pipeline.duration ? `⏱️ **Длительность:** ${pipeline.duration} сек` : ''}
${pipeline.coverage ? `📊 **Покрытие:** ${pipeline.coverage}%` : ''}

**Проект:**
🏠 **Хост:** ${pipeline.project.host}
📁 **Пространство имен:** ${pipeline.project.namespace}
📦 **Проект:** ${pipeline.project.name}

Указанная директория проекта: ${projectPath}
Рабочая директория MCP сервера: ${process.cwd()}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Ошибка при получении последнего пайплайна: ${error.message}\n\nУказанная директория проекта: ${request.params.arguments?.project_path || 'НЕ УКАЗАНА'}\nРабочая директория MCP сервера: ${process.cwd()}`,
              },
            ],
          };
        }
      }

      if (request.params.name === 'get_pipeline_details') {
        try {
          // Получаем обязательный путь к проекту от ИИ агента
          const rawProjectPath = request.params.arguments?.project_path;
          const pipelineId = request.params.arguments?.pipeline_id;

          if (!rawProjectPath) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Параметр project_path обязателен! ИИ агент должен передать полный путь к директории проекта, из которого он работает.\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          // Нормализуем путь для кроссплатформенности
          const projectPath = resolve(rawProjectPath);

          // Получаем подробную информацию о пайплайне
          const result = await this.getPipelineDetails(projectPath, pipelineId);

          if (!result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: ${result.message}\n\nУказанная директория проекта: ${projectPath}\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          if (!result.data) {
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ ${result.message}\n\nУказанная директория проекта: ${projectPath}\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          const { pipeline, jobs, artifacts } = result.data;
          const statusEmoji = {
            'success': '✅',
            'failed': '❌',
            'running': '🔄',
            'pending': '⏳',
            'canceled': '⏹️',
            'skipped': '⏭️',
            'manual': '👤'
          };

          const emoji = statusEmoji[pipeline.status] || '❓';

          // Формируем детальную информацию о пайплайне
          let output = `🔍 **ПОДРОБНАЯ ИНФОРМАЦИЯ О ПАЙПЛАЙНЕ GitLab**

${emoji} **Статус:** ${pipeline.status.toUpperCase()}
🆔 **ID:** ${pipeline.id}
🌿 **Ветка:** ${pipeline.ref}
📝 **SHA:** ${pipeline.sha.substring(0, 8)}
🔗 **Ссылка:** ${pipeline.web_url}
📅 **Создан:** ${new Date(pipeline.created_at).toLocaleString('ru-RU')}
🔄 **Обновлен:** ${new Date(pipeline.updated_at).toLocaleString('ru-RU')}
${pipeline.duration ? `⏱️ **Длительность:** ${pipeline.duration} сек` : ''}
${pipeline.coverage ? `📊 **Покрытие:** ${pipeline.coverage}%` : ''}
${pipeline.source ? `📋 **Источник:** ${pipeline.source}` : ''}
${pipeline.tag ? `🏷️ **Тег:** ${pipeline.tag}` : ''}
${pipeline.user ? `👤 **Пользователь:** ${pipeline.user.name} (${pipeline.user.username})` : ''}

**Проект:**
🏠 **Хост:** ${pipeline.project.host}
📁 **Пространство имен:** ${pipeline.project.namespace}
📦 **Проект:** ${pipeline.project.name}

`;

          // Добавляем информацию о джобах
          if (jobs && jobs.length > 0) {
            output += `\n## 📋 **ДЖОБЫ ПАЙПЛАЙНА** (${jobs.length})\n\n`;
            
            jobs.forEach((job, index) => {
              const jobEmoji = statusEmoji[job.status] || '❓';
              output += `### ${index + 1}. ${jobEmoji} **${job.name}** (ID: ${job.id})
**Статус:** ${job.status.toUpperCase()}
**Этап:** ${job.stage}
${job.duration ? `**Длительность:** ${job.duration} сек` : ''}
${job.queued_duration ? `**Время в очереди:** ${job.queued_duration} сек` : ''}
${job.web_url ? `**Ссылка:** ${job.web_url}` : ''}
${job.artifacts_file ? `**Артефакты:** ${job.artifacts_file.filename} (${job.artifacts_file.size} байт)` : ''}
${job.tag_list && job.tag_list.length > 0 ? `**Теги:** ${job.tag_list.join(', ')}` : ''}

`;

              // Добавляем логи джоба если они есть
              if (job.trace && job.trace.trim()) {
                output += `**📝 ЛОГИ ДЖОБА:**
\`\`\`
${job.trace.length > 2000 ? job.trace.substring(0, 2000) + '\n... (логи обрезаны для читаемости)' : job.trace}
\`\`\`

`;
              }
            });
          } else {
            output += `\n## 📋 **ДЖОБЫ ПАЙПЛАЙНА**
Джобы не найдены или еще не созданы.

`;
          }

          // Добавляем информацию об артефактах
          if (artifacts && artifacts.length > 0) {
            output += `\n## 📦 **АРТЕФАКТЫ ПАЙПЛАЙНА** (${artifacts.length})\n\n`;
            
            artifacts.forEach((artifact, index) => {
              output += `${index + 1}. **${artifact.filename}**
**Размер:** ${artifact.size} байт
**Тип:** ${artifact.file_type || 'неизвестно'}
**Создан:** ${new Date(artifact.created_at).toLocaleString('ru-RU')}
${artifact.download_path ? `**Ссылка для скачивания:** ${artifact.download_path}` : ''}

`;
            });
          } else {
            output += `\n## 📦 **АРТЕФАКТЫ ПАЙПЛАЙНА**
Артефакты не найдены.

`;
          }

          output += `\n---\n**Указанная директория проекта:** ${projectPath}\n**Рабочая директория MCP сервера:** ${process.cwd()}`;

          return {
            content: [
              {
                type: 'text',
                text: output,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Ошибка при получении подробной информации о пайплайне: ${error.message}\n\nУказанная директория проекта: ${request.params.arguments?.project_path || 'НЕ УКАЗАНА'}\nРабочая директория MCP сервера: ${process.cwd()}`,
              },
            ],
          };
        }
      }

      if (request.params.name === 'get_job_details') {
        try {
          const rawProjectPath = request.params.arguments?.project_path;
          const jobId = request.params.arguments?.job_id;

          if (!rawProjectPath) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Параметр project_path обязателен! ИИ агент должен передать полный путь к директории проекта, из которого он работает.\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          if (!jobId) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Параметр job_id обязателен! Укажите ID джоба для получения информации.\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          const projectPath = resolve(rawProjectPath);
          const result = await this.getJobDetails(projectPath, jobId);

          if (!result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: ${result.message}\n\nУказанная директория проекта: ${projectPath}\nID джоба: ${jobId}\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          const { job, project } = result.data;
          const statusEmoji = {
            'success': '✅',
            'failed': '❌',
            'running': '🔄',
            'pending': '⏳',
            'canceled': '⏹️',
            'skipped': '⏭️',
            'manual': '👤'
          };

          const emoji = statusEmoji[job.status] || '❓';

          let output = `🔧 **ИНФОРМАЦИЯ О ДЖОБЕ GitLab**

${emoji} **Статус:** ${job.status.toUpperCase()}
🆔 **ID:** ${job.id}
📝 **Название:** ${job.name}
🏗️ **Этап:** ${job.stage}
${job.duration ? `⏱️ **Длительность:** ${job.duration} сек` : ''}
${job.queued_duration ? `⏳ **Время в очереди:** ${job.queued_duration} сек` : ''}
${job.web_url ? `🔗 **Ссылка:** ${job.web_url}` : ''}
${job.tag_list && job.tag_list.length > 0 ? `🏷️ **Теги:** ${job.tag_list.join(', ')}` : ''}
${job.artifacts_file ? `📦 **Артефакты:** ${job.artifacts_file.filename} (${job.artifacts_file.size} байт)` : ''}
${job.coverage ? `📊 **Покрытие:** ${job.coverage}%` : ''}
${job.allow_failure ? `⚠️ **Разрешить неудачу:** ${job.allow_failure}` : ''}

**Временные метки:**
📅 **Создан:** ${new Date(job.created_at).toLocaleString('ru-RU')}
🔄 **Начат:** ${job.started_at ? new Date(job.started_at).toLocaleString('ru-RU') : 'Не начат'}
✅ **Завершен:** ${job.finished_at ? new Date(job.finished_at).toLocaleString('ru-RU') : 'Не завершен'}

**Проект:**
🏠 **Хост:** ${project.host}
📁 **Пространство имен:** ${project.namespace}
📦 **Проект:** ${project.name}

**Указанная директория проекта:** ${projectPath}
**Рабочая директория MCP сервера:** ${process.cwd()}`;

          return {
            content: [
              {
                type: 'text',
                text: output,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Ошибка при получении информации о джобе: ${error.message}\n\nУказанная директория проекта: ${request.params.arguments?.project_path || 'НЕ УКАЗАНА'}\nID джоба: ${request.params.arguments?.job_id || 'НЕ УКАЗАН'}\nРабочая директория MCP сервера: ${process.cwd()}`,
              },
            ],
          };
        }
      }

      if (request.params.name === 'get_job_logs') {
        try {
          const rawProjectPath = request.params.arguments?.project_path;
          const jobId = request.params.arguments?.job_id;

          if (!rawProjectPath) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Параметр project_path обязателен! ИИ агент должен передать полный путь к директории проекта, из которого он работает.\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          if (!jobId) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Параметр job_id обязателен! Укажите ID джоба для получения логов.\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          const projectPath = resolve(rawProjectPath);
          const result = await this.getJobLogs(projectPath, jobId);

          if (!result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: ${result.message}\n\nУказанная директория проекта: ${projectPath}\nID джоба: ${jobId}\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          const { job, logs, project } = result.data;
          const statusEmoji = {
            'success': '✅',
            'failed': '❌',
            'running': '🔄',
            'pending': '⏳',
            'canceled': '⏹️',
            'skipped': '⏭️',
            'manual': '👤'
          };

          const emoji = statusEmoji[job.status] || '❓';

          let output = `📝 **ЛОГИ ДЖОБА GitLab**

${emoji} **Джоб:** ${job.name} (ID: ${job.id})
**Статус:** ${job.status.toUpperCase()}
**Этап:** ${job.stage}
${job.web_url ? `🔗 **Ссылка:** ${job.web_url}` : ''}

**Проект:**
🏠 **Хост:** ${project.host}
📁 **Пространство имен:** ${project.namespace}
📦 **Проект:** ${project.name}

`;

          if (logs && logs.trim()) {
            output += `## 📋 **ЛОГИ ВЫПОЛНЕНИЯ:**

\`\`\`
${logs.length > 3000 ? logs.substring(0, 3000) + '\n... (логи обрезаны для читаемости)' : logs}
\`\`\`

`;
          } else {
            output += `## 📋 **ЛОГИ ВЫПОЛНЕНИЯ:**
Логи не найдены или джоб еще не выполнялся.

`;
          }

          output += `**Указанная директория проекта:** ${projectPath}\n**Рабочая директория MCP сервера:** ${process.cwd()}`;

          return {
            content: [
              {
                type: 'text',
                text: output,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Ошибка при получении логов джоба: ${error.message}\n\nУказанная директория проекта: ${request.params.arguments?.project_path || 'НЕ УКАЗАНА'}\nID джоба: ${request.params.arguments?.job_id || 'НЕ УКАЗАН'}\nРабочая директория MCP сервера: ${process.cwd()}`,
              },
            ],
          };
        }
      }

      if (request.params.name === 'get_job_artifacts') {
        try {
          const rawProjectPath = request.params.arguments?.project_path;
          const jobId = request.params.arguments?.job_id;

          if (!rawProjectPath) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Параметр project_path обязателен! ИИ агент должен передать полный путь к директории проекта, из которого он работает.\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          if (!jobId) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Параметр job_id обязателен! Укажите ID джоба для получения артефактов.\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          const projectPath = resolve(rawProjectPath);
          const result = await this.getJobArtifacts(projectPath, jobId);

          if (!result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: ${result.message}\n\nУказанная директория проекта: ${projectPath}\nID джоба: ${jobId}\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          const { job, artifacts, project } = result.data;
          const statusEmoji = {
            'success': '✅',
            'failed': '❌',
            'running': '🔄',
            'pending': '⏳',
            'canceled': '⏹️',
            'skipped': '⏭️',
            'manual': '👤'
          };

          const emoji = statusEmoji[job.status] || '❓';

          let output = `📦 **АРТЕФАКТЫ ДЖОБА GitLab**

${emoji} **Джоб:** ${job.name} (ID: ${job.id})
**Статус:** ${job.status.toUpperCase()}
**Этап:** ${job.stage}
${job.web_url ? `🔗 **Ссылка:** ${job.web_url}` : ''}

**Проект:**
🏠 **Хост:** ${project.host}
📁 **Пространство имен:** ${project.namespace}
📦 **Проект:** ${project.name}

`;

          if (artifacts && artifacts.length > 0) {
            output += `## 📋 **АРТЕФАКТЫ ДЖОБА** (${artifacts.length})\n\n`;
            
            artifacts.forEach((artifact, index) => {
              output += `${index + 1}. **${artifact.filename}**
**Размер:** ${artifact.size} байт
**Тип:** ${artifact.file_type || 'неизвестно'}
**Создан:** ${new Date(artifact.created_at).toLocaleString('ru-RU')}
${artifact.download_path ? `**Ссылка для скачивания:** ${artifact.download_path}` : ''}

`;
            });
          } else {
            output += `## 📋 **АРТЕФАКТЫ ДЖОБА**
Артефакты не найдены или джоб еще не создал артефакты.

`;
          }

          output += `**Указанная директория проекта:** ${projectPath}\n**Рабочая директория MCP сервера:** ${process.cwd()}`;

          return {
            content: [
              {
                type: 'text',
                text: output,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Ошибка при получении артефактов джоба: ${error.message}\n\nУказанная директория проекта: ${request.params.arguments?.project_path || 'НЕ УКАЗАНА'}\nID джоба: ${request.params.arguments?.job_id || 'НЕ УКАЗАН'}\nРабочая директория MCP сервера: ${process.cwd()}`,
              },
            ],
          };
        }
      }

      if (request.params.name === 'download_job_artifacts') {
        try {
          const rawProjectPath = request.params.arguments?.project_path;
          const jobId = request.params.arguments?.job_id;
          const downloadPath = request.params.arguments?.download_path;

          if (!rawProjectPath) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Параметр project_path обязателен! ИИ агент должен передать полный путь к директории проекта, из которого он работает.\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          if (!jobId) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Параметр job_id обязателен! Укажите ID джоба для скачивания артефактов.\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          const projectPath = resolve(rawProjectPath);
          const result = await this.downloadJobArtifacts(projectPath, jobId, downloadPath);

          if (!result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: ${result.message}\n\nУказанная директория проекта: ${projectPath}\nID джоба: ${jobId}\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          const { job, downloadedFiles, downloadPath: finalDownloadPath, archivePath, archiveSize } = result.data;
          const statusEmoji = {
            'success': '✅',
            'failed': '❌',
            'running': '🔄',
            'pending': '⏳',
            'canceled': '⏹️',
            'skipped': '⏭️',
            'manual': '👤'
          };

          const emoji = statusEmoji[job.status] || '❓';

          let output = `📥 **СКАЧИВАНИЕ АРТЕФАКТОВ ДЖОБА GitLab**

${emoji} **Джоб:** ${job.name} (ID: ${job.id})
**Статус:** ${job.status.toUpperCase()}
**Этап:** ${job.stage}
${job.web_url ? `🔗 **Ссылка:** ${job.web_url}` : ''}

`;

          if (downloadedFiles && downloadedFiles.length > 0) {
            output += `## 📦 **СКАЧАННЫЕ АРТЕФАКТЫ**

✅ **Статус:** Скачивание завершено успешно
📁 **Путь сохранения:** ${finalDownloadPath}
📄 **Файлы:** ${downloadedFiles.join(', ')}
💾 **Размер архива:** ${archiveSize} байт (${(archiveSize / 1024 / 1024).toFixed(2)} МБ)
📂 **Полный путь к архиву:** ${archivePath}

**Инструкции для исследования:**
1. Распакуйте ZIP архив для просмотра содержимого
2. Изучите файлы артефактов в зависимости от типа джоба
3. Проверьте логи, отчеты, собранные файлы и т.д.

`;
          } else {
            output += `## 📦 **АРТЕФАКТЫ**

ℹ️ **Статус:** У джоба нет артефактов для скачивания
**Причина:** Джоб не создал артефакты или они были удалены

`;
          }

          output += `**Указанная директория проекта:** ${projectPath}\n**Рабочая директория MCP сервера:** ${process.cwd()}`;

          return {
            content: [
              {
                type: 'text',
                text: output,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Ошибка при скачивании артефактов джоба: ${error.message}\n\nУказанная директория проекта: ${request.params.arguments?.project_path || 'НЕ УКАЗАНА'}\nID джоба: ${request.params.arguments?.job_id || 'НЕ УКАЗАН'}\nРабочая директория MCP сервера: ${process.cwd()}`,
              },
            ],
          };
        }
      }

      if (request.params.name === 'download_pipeline_artifacts') {
        try {
          const rawProjectPath = request.params.arguments?.project_path;
          const pipelineId = request.params.arguments?.pipeline_id;
          const downloadPath = request.params.arguments?.download_path;

          if (!rawProjectPath) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: Параметр project_path обязателен! ИИ агент должен передать полный путь к директории проекта, из которого он работает.\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          const projectPath = resolve(rawProjectPath);
          const result = await this.downloadPipelineArtifacts(projectPath, pipelineId, downloadPath);

          if (!result.success) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ОШИБКА: ${result.message}\n\nУказанная директория проекта: ${projectPath}\nID пайплайна: ${pipelineId || 'последний'}\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          if (!result.data) {
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ ${result.message}\n\nУказанная директория проекта: ${projectPath}\nРабочая директория MCP сервера: ${process.cwd()}`,
                },
              ],
            };
          }

          const { pipelineId: finalPipelineId, jobs, jobsWithArtifacts, downloadedFiles, downloadPath: finalDownloadPath, downloadResults } = result.data;

          let output = `📥 **СКАЧИВАНИЕ АРТЕФАКТОВ ПАЙПЛАЙНА GitLab**

🆔 **ID пайплайна:** ${finalPipelineId}
📋 **Всего джобов:** ${jobs.length}
📦 **Джобов с артефактами:** ${jobsWithArtifacts.length}

`;

          if (downloadedFiles && downloadedFiles.length > 0) {
            const successfulDownloads = downloadResults.filter(r => r.success);
            const failedDownloads = downloadResults.filter(r => !r.success);

            output += `## 📦 **РЕЗУЛЬТАТЫ СКАЧИВАНИЯ**

✅ **Успешно скачано:** ${successfulDownloads.length} архивов
❌ **Ошибок:** ${failedDownloads.length}
📁 **Путь сохранения:** ${finalDownloadPath}
📄 **Скачанные файлы:** ${downloadedFiles.join(', ')}

### 📋 **ДЕТАЛИ СКАЧИВАНИЯ:**

`;

            downloadResults.forEach((result, index) => {
              if (result.success) {
                output += `${index + 1}. ✅ **${result.jobName}** (ID: ${result.jobId})
   📄 Файл: ${result.fileName}
   💾 Размер: ${result.size} байт (${(result.size / 1024 / 1024).toFixed(2)} МБ)

`;
              } else {
                output += `${index + 1}. ❌ **${result.jobName}** (ID: ${result.jobId})
   ⚠️ Ошибка: ${result.error}

`;
              }
            });

            output += `**Инструкции для исследования:**
1. Распакуйте каждый ZIP архив для просмотра содержимого
2. Изучите артефакты каждого джоба в зависимости от их типа
3. Проверьте логи, отчеты, собранные файлы и т.д.
4. Сравните артефакты между разными джобами пайплайна

`;
          } else {
            output += `## 📦 **АРТЕФАКТЫ**

ℹ️ **Статус:** В пайплайне нет джобов с артефактами
**Причина:** Ни один джоб не создал артефакты или они были удалены

`;
          }

          output += `**Указанная директория проекта:** ${projectPath}\n**Рабочая директория MCP сервера:** ${process.cwd()}`;

          return {
            content: [
              {
                type: 'text',
                text: output,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Ошибка при скачивании артефактов пайплайна: ${error.message}\n\nУказанная директория проекта: ${request.params.arguments?.project_path || 'НЕ УКАЗАНА'}\nID пайплайна: ${request.params.arguments?.pipeline_id || 'НЕ УКАЗАН'}\nРабочая директория MCP сервера: ${process.cwd()}`,
              },
            ],
          };
        }
      }

      throw new Error(`Неизвестная тулза: ${request.params.name}`);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('GitLab MCP Server запущен и готов к работе!');
  }
}

// Запуск сервера
const server = new GitLabMCPServer();
server.run().catch(console.error);
