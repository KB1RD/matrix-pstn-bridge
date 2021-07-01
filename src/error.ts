export class UserFriendlyError extends Error {
  constructor(desc: string) {
    super(desc);
  }
}
