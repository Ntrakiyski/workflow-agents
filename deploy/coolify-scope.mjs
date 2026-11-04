/** Verify an exact project/environment membership without relying on optional nested app fields. */
export async function verifyApplicationScope(api, { project, environment, uuid, name, environmentName = 'staging' }) {
  const selectedProject = await api('GET', '/projects/' + project);
  if (selectedProject.uuid !== project || !Array.isArray(selectedProject.environments))
    throw Error('project_scope_mismatch');
  const matches = selectedProject.environments.filter(item => item.uuid === environment && item.name === environmentName);
  if (matches.length !== 1) throw Error('environment_scope_mismatch');
  const selectedEnvironment = await api('GET', '/projects/' + project + '/' + encodeURIComponent(environmentName));
  if (selectedEnvironment.uuid !== environment ||
      (selectedEnvironment.name !== undefined && selectedEnvironment.name !== environmentName) ||
      !Array.isArray(selectedEnvironment.applications)) throw Error('environment_scope_mismatch');
  const members = selectedEnvironment.applications.filter(item => item.uuid === uuid && item.name === name);
  if (members.length !== 1 || (members[0].environment_id !== undefined && members[0].environment_id !== selectedEnvironment.id))
    throw Error('application_membership_mismatch');
  const app = await api('GET', '/applications/' + uuid);
  if (app.uuid !== uuid || app.name !== name ||
      (app.environment_id !== undefined && app.environment_id !== selectedEnvironment.id) ||
      (app.environment?.uuid !== undefined && app.environment.uuid !== environment) ||
      (app.environment?.project?.uuid !== undefined && app.environment.project.uuid !== project))
    throw Error('application_scope_mismatch');
  return app;
}
