function test (url) {
  console.log("testing test function", url)
  var fetchOptions = {
    credentials: 'include'
  };

  return fetch(url, fetchOptions).then(function (res) {
    console.log(res);
    return res.ok ? res.json() : Promise.reject(res);
  })
}

// test("http://localhost:8080/api/v1/dags/sleep_tasks/dagRuns");

async function getStateFromTaskInstance(url) {
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
    return taskInstanceData.state; // Return the state from the response
  } else {
    console.error(`No dag_run found for dag_id: ${dag_id} and execution_date: ${execution_date}`);
    throw new Error(`No dag_run found for dag_id: ${dag_id} and execution_date: ${execution_date}`);
  }
}

// const url = 'http://localhost:8080/task?dag_id=sleep_tasks&task_id=sleep_15&execution_date=2023-04-11T21%3A18%3A59.175443%2B00%3A00';
// getStateFromTaskInstance(url)
//   .then(state => console.log('Task Instance State:', state))
//   .catch(error => console.error('Error:', error));
