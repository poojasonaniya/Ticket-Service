import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'id may only contain letters, numbers, dot, underscore and hyphen',
  })
  id: string;

  // empty subject is fine, t-1008 in the sample data has none
  @IsString()
  @MaxLength(500)
  subject: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  body: string;
}
