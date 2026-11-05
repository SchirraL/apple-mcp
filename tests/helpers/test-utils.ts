import { run } from "@jxa/run";
import { runAppleScript } from "run-applescript";
import { TEST_DATA } from "../fixtures/test-data.js";

export interface TestDataManager {
  setupTestData: () => Promise<void>;
  cleanupTestData: () => Promise<void>;
}

export function createTestDataManager(): TestDataManager {
  return {
    async setupTestData() {
      console.log("Setting up test contacts...");
      await setupTestContact();
    },

    async cleanupTestData() {
      // Note: We don't clean up contacts as they might be useful to keep
      console.log("Leaving test contact for manual cleanup if needed");
    }
  };
}

// Setup functions
async function setupTestContact(): Promise<void> {
  try {
    const script = `
tell application "Contacts"
    -- Check if test contact already exists
    set existingContacts to (every person whose name is "${TEST_DATA.CONTACT.name}")
    
    if (count of existingContacts) is 0 then
        -- Create new contact
        set newPerson to make new person with properties {first name:"Test Contact", last name:"Claude"}
        make new phone at end of phones of newPerson with properties {label:"iPhone", value:"${TEST_DATA.PHONE_NUMBER}"}
        save
        return "Created test contact"
    else
        return "Test contact already exists"
    end if
end tell`;
    
    await runAppleScript(script);
  } catch (error) {
    console.warn("Could not set up test contact:", error);
  }
}

// Test assertion helpers
export function assertNotEmpty<T>(value: T[], message: string): void {
  if (!value || value.length === 0) {
    throw new Error(message);
  }
}

export function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.toLowerCase().includes(needle.toLowerCase())) {
    throw new Error(`${message}. Expected "${haystack}" to contain "${needle}"`);
  }
}

export function assertValidPhoneNumber(phoneNumber: string | null): void {
  if (!phoneNumber) {
    throw new Error("Expected valid phone number, got null or undefined");
  }
  const normalized = phoneNumber.replace(/[^0-9+]/g, '');
  if (!normalized.includes('4803764369')) {
    throw new Error(`Expected phone number to contain test number, got: ${phoneNumber}`);
  }
}

export function assertValidDate(dateString: string | null): void {
  if (!dateString) {
    throw new Error("Expected valid date string, got null");
  }
  
  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date string: ${dateString}`);
  }
}

// Utility to wait for async operations
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}