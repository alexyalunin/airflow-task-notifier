/**
 * Yet Another Jenkins Notifier
 * Copyright (C) 2016 Guillaume Girou
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

var Services = (function () {
  'use strict';

  var _ = {
    forEach: function (obj, iterator) {
      if (obj) {
        if (obj.forEach) {
          obj.forEach(iterator);
        } else if ('length' in obj && obj.length > 0) {
          for (var i = 0; i < obj.length; i++) {
            iterator(obj[i], i);
          }
        } else {
          for (var key in obj) {
            if (obj.hasOwnProperty(key)) {
              iterator(obj[key], key);
            }
          }
        }
      }
      return obj;
    },
    clone: function (obj) {
      return JSON.parse(JSON.stringify(obj));
    }
  };

  async function getTaskInstanceData(url) {
    const urlObj = new URL(url);
    const host = `${urlObj.protocol}//${urlObj.host}`;

    // Extract dag_id, task_id, and execution_date from the given URL
    const urlParams = new URLSearchParams(new URL(url).search);
    const dag_id = urlParams.get('dag_id');
    const task_id = urlParams.get('task_id');
    const execution_date = urlParams.get('execution_date');

    // Make a GET request to fetch dag_runs for the given dag_id
    const dagRunsResponse = await fetch(`${host}/api/v1/dags/${dag_id}/dagRuns`);
    const dagRunsData = await dagRunsResponse.json();

    // Find the dag_run with matching dag_run_id
    const dagRun = dagRunsData.dag_runs.find(dagRun => dagRun.dag_run_id.includes(execution_date));

    // If dag_run is found, make a GET request to fetch task_instance for the given task_id
    if (dagRun) {
      console.log(`Found dag_run for dag_id: ${dag_id}, execution_date: ${execution_date}, with dag_run_id: ${dagRun.dag_run_id}`);
      // Make a GET request to fetch task_instance for the given task_id
      const taskInstanceResponse = await fetch(`${host}/api/v1/dags/${dag_id}/dagRuns/${dagRun.dag_run_id}/taskInstances/${task_id}`);
      const taskInstanceData = await taskInstanceResponse.json();
      console.log(`Fetched task_instance for task_id: ${task_id}`);
      return taskInstanceData; // Return the state from the response
    } else {
      console.error(`No dag_run found for dag_id: ${dag_id} and execution_date: ${execution_date}`);
      throw new Error(`No dag_run found for dag_id: ${dag_id} and execution_date: ${execution_date}`);
    }
  }

  // Initialize options and listen for changes
  function initOptions($rootScope, Storage) {
    $rootScope.options = {
      refreshTime: 15,
      notification: 'all'
    };

    Storage.get({options: $rootScope.options}).then(function (objects) {
      $rootScope.options = objects.options;
      $rootScope.$broadcast('Options::options.changed', $rootScope.options);
    });

    Storage.onChanged.addListener(function (objects) {
      if (objects.options) {
        $rootScope.options = objects.options.newValue;
        $rootScope.$broadcast('Options::options.changed', $rootScope.options);
      }
    });
  }

  // Initialize jobs and listen for changes
  function initJobs(Jobs, Storage, $rootScope) {
    Jobs.jobs = {};

    Storage.get({jobs: Jobs.jobs}).then(function (objects) {
      Jobs.jobs = objects.jobs;
      $rootScope.$broadcast('Jobs::jobs.initialized', Jobs.jobs);
      $rootScope.$broadcast('Jobs::jobs.changed', Jobs.jobs);
    });

    Storage.onChanged.addListener(function (objects) {
      if (objects.jobs) {
        Jobs.jobs = objects.jobs.newValue;
        $rootScope.$broadcast('Jobs::jobs.changed', Jobs.jobs);
      }
    });
  }

  function defaultJobDataService() {
    return function (url, status) {
      const urlParams = new URLSearchParams(new URL(url).search);
      const task_id = urlParams.get('task_id');
      return {
        name: decodeURI(task_id),
        url: decodeURI(url),
        building: false,
        status: status || '',
        statusClass: undefined,
        statusIcon: undefined,
        error: undefined,
      };
    }
  }

  function JobsService($q, Storage, jenkins, defaultJobData) {
    var Jobs = {
      jobs: {},
      add: function (url, data) {
        var result = {};
        result.oldValue = Jobs.jobs[url];
        result.newValue = Jobs.jobs[url] = data || Jobs.jobs[url] || defaultJobData(url);
        return Storage.set({jobs: Jobs.jobs}).then(function () {
          return result;
        });
      },
      remove: function (url) {
        delete Jobs.jobs[url];
        return Storage.set({jobs: Jobs.jobs});
      },
      setUrls: function (urls) {
        var newJobs = {};
        urls.forEach(function (url) {
          newJobs[url] = Jobs.jobs[url] || defaultJobData(url);
        });
        Jobs.jobs = newJobs;

        return Storage.set({jobs: Jobs.jobs}).then(function () {
          return Jobs.jobs;
        });
      },
      updateStatus: function (url) {
        return jenkins(url).catch(function (res) {
          // On error, keep existing data or create default one
          var data = _.clone(Jobs.jobs[url]) || defaultJobData(url);
          data.error = (res instanceof Error ? res.message : res.statusText) || 'Unreachable';
          return data;
        }).then(function (data) {
          return Jobs.add(url, data);
        });
      },
      updateAllStatus: function () {
        var promises = [];
        _.forEach(Jobs.jobs, function (_, url) {
          promises.push(Jobs.updateStatus(url));
        });
        return $q.when(promises);
      }
    };

    return Jobs;
  }

  function jenkinsService(defaultJobData) {
    var stateToClass = {
      'success': 'success', 'skipped': 'warning', 'failed': 'danger'
    };
    var stateToIcon = {
      'success': 'green', 'skipped': 'yellow', 'failed': 'red'
    };

    var fetchOptions = {
      credentials: 'include'
    };

    function jobMapping(url, taskInstanceData) {
      // stateToClass, class is used for alerts
      // "success" "running" "failed" "upstream_failed" "skipped" "up_for_retry" "up_for_reschedule" "queued" "none" "scheduled" "deferred" "removed" "restarting"
      const state = taskInstanceData.state
      return {
        name: taskInstanceData.task_id || taskInstanceData.name || 'Task',
        url: decodeURI(url),
        building: state === 'running',
        status: state,
        statusClass: stateToClass[state] || '',
        statusIcon: stateToIcon[state] || 'grey',
        lastBuildTime: taskInstanceData.end_date,
      };
    }

    function subJobKey(url) {
      return url.replace(/^.+?\/job\/(.+)\/$/, "$1").replace(/\/job\//g, "/");
    }

    return function (url) {
      return getTaskInstanceData(url).then(function (taskInstanceData) {
        console.log(taskInstanceData)
        return jobMapping(url, taskInstanceData);
      });

      // return fetch(url + 'api/json/', fetchOptions).then(function (res) {
      //   return res.ok ? res.json() : Promise.reject(res);
      // }).then(function (data) {
      //   var job = jobMapping(url, data);
      //
      //   return job;
      // });
    }
  }

  function buildWatcherService($rootScope, Jobs, buildNotifier) {
    function runUpdateAndNotify(options) {
      if (options.notification === 'none')
        return;

      return window.setInterval(function (Jobs, buildNotifier) {
        Jobs.updateAllStatus().then(buildNotifier);
      }, options.refreshTime * 1000, Jobs, buildNotifier);
    }

    return function () {
      var currentInterval = runUpdateAndNotify($rootScope.options);

      $rootScope.$on('Options::options.changed', function (_, options) {
        window.clearInterval(currentInterval);
        currentInterval = runUpdateAndNotify(options);
      });
    };
  }

  function buildNotifierService($rootScope, Notification) {
    function jobNotifier(newValue, oldValue) {
      oldValue = oldValue || {};
      if (oldValue.status === newValue.status) {
        return;
      }

      if (newValue.status === 'running') {
        return;
      }

      const title = 'Task is ' + newValue.status + '!';
      const buildUrl = newValue.url;
      Notification.create(null, {
          type: 'basic',
          title: title + ' - ' + newValue.name,
          message: buildUrl,
          iconUrl: 'img/logo-' + newValue.statusIcon + '.svg'
        },
        {
          onClicked: function () {
            chrome.tabs.create({'url': buildUrl});
          }
        }
      );
    }

    return function (promises) {
      promises.forEach(function (promise) {
        promise.then(function (data) {
          // Disable notification for pending promises
          if ($rootScope.options.notification === 'none')
            return;

          var oldValue = data.oldValue;
          var newValue = data.newValue;

          if (newValue.jobs) {
            _.forEach(newValue.jobs, function (job, url) {
              jobNotifier(job, oldValue && oldValue.jobs && oldValue.jobs[url]);
            });
          } else {
            jobNotifier(newValue, oldValue);
          }
        });
      });
    };
  }

  function StorageService($q) {
    var storage = chrome.storage.local;

    function promisedCallback(deferred) {
      return function (data) {
        if (chrome.runtime.lastError) {
          deferred.reject(runtime.lastError);
        } else {
          deferred.resolve(data);
        }
      };
    }

    return {
      onChanged: chrome.storage.onChanged,
      get: function (keys) {
        var deferred = $q.defer();
        storage.get(keys, promisedCallback(deferred));
        return deferred.promise;
      },
      set: function (objects) {
        var deferred = $q.defer();
        storage.set(objects, promisedCallback(deferred));
        return deferred.promise;
      }
    };
  }

  function NotificationService($q) {
    var notifications = chrome.notifications;
    var Listeners = {};

    notifications.onClicked.addListener(function (notificationId) {
      var listener = Listeners[notificationId] || {};
      if (typeof listener.onClicked === 'function') {
        listener.onClicked();
      }
    });

    notifications.onClosed.addListener(function (notificationId) {
      var listener = Listeners[notificationId] || {};
      if (typeof listener.onClosed === 'function') {
        listener.onClosed();
      }
      delete Listeners[notificationId];
    });

    return {
      create: function (notificationId, options, listeners) {
        var deferred = $q.defer();
        notifications.create(notificationId, options, deferred.resolve);
        return deferred.promise.then(function (notificationId) {
          Listeners[notificationId] = listeners;
          return notificationId;
        });
      }
    };
  }

  var $rootScope = {
    $broadcast: function (name, detail) {
      window.dispatchEvent(new CustomEvent(name, {detail: detail}));
    },
    $on: function (name, callback) {
      window.addEventListener(name, function (e) {
        callback(e, e.detail);
      });
    }
  };
  var $q = {
    defer: function () {
      var defer = {};
      defer.promise = new Promise(function (resolve, reject) {
        defer.resolve = resolve;
        defer.reject = reject;
      });
      return defer;
    },
    when: function (value) {
      return Promise.resolve(value);
    },
    all: function (iterable) {
      return Promise.all(iterable);
    }
  };
  var Storage = StorageService($q);
  var defaultJobData = defaultJobDataService();
  var jenkins = jenkinsService(defaultJobData);
  var Jobs = JobsService($q, Storage, jenkins, defaultJobData);
  var Notification = NotificationService($q);
  var buildNotifier = buildNotifierService($rootScope, Notification);
  var buildWatcher = buildWatcherService($rootScope, Jobs, buildNotifier);

  return {
    _: _,
    $rootScope: $rootScope,
    $q: $q,
    Storage: Storage,
    Jobs: Jobs,
    Notification: Notification,
    buildNotifier: buildNotifier,
    buildWatcher: buildWatcher,
    init: function () {
      initOptions($rootScope, Storage);
      initJobs(Jobs, Storage, $rootScope);
    }
  };
})();
