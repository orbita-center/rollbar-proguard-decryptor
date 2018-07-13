// Saves options to chrome.storage
function save_options() {
    chrome.storage.sync.set({
        apiToken: document.getElementById('apiToken').value
    }, () => console.log('options saved'));
  }
  
  function restore_options() {
    chrome.storage.sync.get({
      apiToken: ''
    }, function(items) {
      document.getElementById('apiToken').value = items.apiToken;
    });
  }
  document.addEventListener('DOMContentLoaded', restore_options);
  document.getElementById('apiToken').addEventListener('change', save_options);